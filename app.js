'use strict';

// ---------- 保存まわり ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
};

const CACHE_TTL = 6 * 60 * 60 * 1000; // 検索結果は6時間使い回してAPIの消費を抑える
const WATCHED_MAX = 5000;
const REFILL_AT = 5;
const RECENT_TITLES_MAX = 300;
const SIMILAR_THRESHOLD = 0.6; // タイトルの似ている度合い(0〜1)がこれ以上なら飛ばす
const CHANNEL_GAP = 3;         // 同じチャンネルは直近この本数の中に入れない

const settings = Object.assign(
  {
    apiKey: '', keywords: [], channels: [], order: 'relevance', maxSec: 180,
    period: 'any', // any | recent | month
    ngWords: [], blocked: [], // blocked: [{ key, name }]
    sleepMin: 0,              // 操作しないままこの分数たったら止める（0 = 止めない）
    subs: 'off',              // off | ja
  },
  store.get('settings', {})
);
let watched = store.get('watched', []);
let watchedSet = new Set(watched);
let recentTitles = store.get('recentTitles', []); // 正規化済みタイトル

let player = null;
let playerReady = false;
let started = false;
let sources = [];
let queue = [];      // これから流す動画
let history = [];    // 流した動画
let pos = -1;        // history の中の現在位置
let refilling = null;
let watchdog = null;

const $ = (id) => document.getElementById(id);

// ---------- YouTube Data API ----------
function addQuota(units) {
  const today = new Date().toISOString().slice(0, 10);
  const q = store.get('quota', { day: today, used: 0 });
  if (q.day !== today) { q.day = today; q.used = 0; }
  q.used += units;
  store.set('quota', q);
}

async function yt(path, params, cost) {
  const url = new URL('https://www.googleapis.com/youtube/v3/' + path);
  for (const [k, v] of Object.entries({ ...params, key: settings.apiKey })) {
    if (v != null && v !== '') url.searchParams.set(k, v);
  }
  addQuota(cost);
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error?.message || ('HTTP ' + res.status));
    err.status = res.status;
    err.reason = json.error?.errors?.[0]?.reason;
    throw err;
  }
  return json;
}

function cached(key, fn) {
  const all = store.get('cache', {});
  const hit = all[key];
  if (hit && Date.now() - hit.t < CACHE_TTL) return Promise.resolve(hit.v);
  return fn().then((v) => {
    const fresh = store.get('cache', {});
    for (const k of Object.keys(fresh)) {
      if (Date.now() - fresh[k].t >= CACHE_TTL) delete fresh[k];
    }
    fresh[key] = { t: Date.now(), v };
    store.set('cache', fresh);
    return v;
  });
}

async function resolveChannelId(input) {
  const map = store.get('channelIds', {});
  if (map[input]) return map[input];

  let id;
  const m = input.match(/(UC[\w-]{22})/);
  if (m) {
    id = m[1];
  } else {
    const h = input.match(/@([^\s/?#]+)/);
    const handle = decodeURIComponent(h ? h[1] : input.replace(/^.*\//, ''));
    const json = await yt('channels', { part: 'id', forHandle: '@' + handle }, 1);
    id = json.items?.[0]?.id;
  }
  if (!id) throw new Error('チャンネルが見つかりません: ' + input);

  map[input] = id;
  store.set('channelIds', map);
  return id;
}

// 期間の設定ごとの検索範囲（日数。null = 指定なし）。
// 「最近を優先」は狭い範囲から始めて、尽きたら次の範囲へ広げる。
const PERIOD_STAGES = {
  any: [null],
  recent: [30, 180, 365, null],
  month: [30],
};

// キャッシュが効くよう、日付は日単位に丸める
function daysAgo(days) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

// ソース1つ分の次のページを取ってくる
async function fetchPage(src) {
  if (src.type === 'keyword') {
    const stages = PERIOD_STAGES[settings.period] || PERIOD_STAGES.any;
    const days = stages[src.stage || 0];
    const after = days == null ? '' : daysAgo(days);
    const key = ['kw', src.q, settings.order, after, src.token].join('|');
    const json = await cached(key, () => yt('search', {
      part: 'snippet',
      q: src.q + ' #shorts',
      type: 'video',
      videoDuration: 'short',
      videoEmbeddable: 'true',
      regionCode: 'JP',
      order: settings.order,
      publishedAfter: after,
      maxResults: 50,
      pageToken: src.token,
    }, 100).then(slimSearch));
    src.token = json.next || '';
    if (!json.next) {
      // この範囲は出し切った。次の範囲があれば広げて続ける
      if ((src.stage || 0) < stages.length - 1) src.stage = (src.stage || 0) + 1;
      else src.done = true;
    }
    return json.items;
  }

  // チャンネル: ショートだけの隠し再生リスト(UUSH...)を使い、駄目なら全動画(UU...)にする
  if (!src.channelId) src.channelId = await resolveChannelId(src.input);
  const prefix = src.fallback ? 'UU' : 'UUSH';
  const playlistId = prefix + src.channelId.slice(2);
  const key = ['pl2', playlistId, src.token].join('|');
  try {
    const json = await cached(key, () => yt('playlistItems', {
      part: 'snippet',
      playlistId,
      maxResults: 50,
      pageToken: src.token,
    }, 1).then(slimPlaylist));
    src.token = json.next || '';
    src.done = !json.next;

    // チャンネルの一覧はもともと新しい順なので、「1か月だけ」の時だけ古いものを切る
    if (settings.period === 'month') {
      const cutoff = daysAgo(30);
      const fresh = json.items.filter((v) => !v.published || v.published >= cutoff);
      if (fresh.length < json.items.length) src.done = true;
      return fresh;
    }
    return json.items;
  } catch (e) {
    if (e.status === 404 && !src.fallback) {
      src.fallback = true;
      src.token = '';
      return fetchPage(src);
    }
    throw e;
  }
}

function slimSearch(json) {
  return {
    next: json.nextPageToken || '',
    items: (json.items || []).map((it) => ({
      id: it.id.videoId,
      title: decodeEntities(it.snippet.title),
      channel: it.snippet.channelTitle,
      channelId: it.snippet.channelId,
    })),
  };
}

function slimPlaylist(json) {
  return {
    next: json.nextPageToken || '',
    items: (json.items || [])
      .filter((it) => it.snippet.title !== 'Private video' && it.snippet.title !== 'Deleted video')
      .map((it) => ({
        id: it.snippet.resourceId.videoId,
        title: it.snippet.title,
        channel: it.snippet.videoOwnerChannelTitle || it.snippet.channelTitle,
        channelId: it.snippet.videoOwnerChannelId || it.snippet.channelId,
        published: it.snippet.publishedAt,
      })),
  };
}

function decodeEntities(s) {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

function parseDuration(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  if (!m) return Infinity;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

// 長さと埋め込み可否で絞り込む
async function filterPlayable(items) {
  const ok = new Map(); // id -> 秒数
  for (let i = 0; i < items.length; i += 50) {
    const ids = items.slice(i, i + 50).map((v) => v.id);
    const json = await cached('vd|' + ids.join(','), () => yt('videos', {
      part: 'contentDetails,status',
      id: ids.join(','),
      maxResults: 50,
    }, 1).then((j) => (j.items || []).map((v) => ({
      id: v.id,
      sec: parseDuration(v.contentDetails.duration),
      embeddable: v.status.embeddable !== false,
    }))));
    for (const v of json) {
      if (v.embeddable && v.sec > 0 && v.sec <= settings.maxSec) ok.set(v.id, v.sec);
    }
  }
  return items.filter((v) => ok.has(v.id)).map((v) => ({ ...v, sec: ok.get(v.id) }));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- 似た動画を避ける ----------
const channelKey = (v) => v.channelId || v.channel || '';

// ハッシュタグ・記号・数字・空白を落として、タイトルの中身だけを比べる
function normTitle(s) {
  return (s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/#\S+/g, '')
    .replace(/[\p{P}\p{S}\p{N}\s]/gu, '');
}

function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

// 2文字ずつの組の重なり具合（Dice係数）
function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const x of A) if (B.has(x)) common++;
  return (2 * common) / (A.size + B.size);
}

function isSimilarToAny(norm, list) {
  if (norm.length < 4) return false; // 短すぎるタイトルは比べても当てにならない
  return list.some((t) => t.length >= 4 && similarity(norm, t) >= SIMILAR_THRESHOLD);
}

function hasNgWord(v) {
  const t = (v.title || '').normalize('NFKC').toLowerCase();
  return settings.ngWords.some((w) => t.includes(w.normalize('NFKC').toLowerCase()));
}

function isBlocked(v) {
  const key = channelKey(v);
  return settings.blocked.some((b) => b.key === key || b.name === v.channel);
}

function buildSources() {
  sources = [
    ...settings.keywords.map((q) => ({ type: 'keyword', q, token: '', done: false })),
    ...settings.channels.map((input) => ({ type: 'channel', input, token: '', done: false })),
  ];
  queue = [];
}

// キューが減ったら、まだ続きがあるソースから少しずつ補充する
function refill() {
  if (refilling) return refilling;
  refilling = (async () => {
    let rounds = 0;
    while (queue.length < REFILL_AT && rounds < 5) {
      rounds++;
      const live = shuffle(sources.filter((s) => !s.done)).slice(0, 3);
      if (!live.length) break;

      const results = await Promise.allSettled(live.map(fetchPage));
      let items = [];
      for (const [i, r] of results.entries()) {
        if (r.status === 'fulfilled') items.push(...r.value);
        else {
          live[i].done = true;
          handleApiError(r.reason);
        }
      }

      const seen = new Set([...queue, ...history].map((v) => v.id));
      items = items.filter((v) => v.id && !watchedSet.has(v.id) && !seen.has(v.id) && seen.add(v.id));
      items = items.filter((v) => !hasNgWord(v) && !isBlocked(v));

      // 最近流したもの・キュー・この回で採用したものとタイトルが似ていたら外す
      const titles = recentTitles.concat(queue.map((v) => normTitle(v.title)));
      items = items.filter((v) => {
        const n = normTitle(v.title);
        if (isSimilarToAny(n, titles)) return false;
        titles.push(n);
        return true;
      });

      items = await filterPlayable(items).catch((e) => { handleApiError(e); return []; });

      queue = shuffle(queue.concat(items));
    }
  })().finally(() => { refilling = null; });
  return refilling;
}

function handleApiError(e) {
  console.error(e);
  if (e?.reason === 'quotaExceeded') toast('今日のAPI使用量の上限に達しました。明日また使えます。');
  else if (e?.status === 400 || e?.status === 403) toast('APIエラー: キーや設定を確認してください\n' + e.message);
  else toast(e?.message || String(e));
}

// ---------- 再生 ----------
window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('player', {
    width: '100%',
    height: '100%',
    playerVars: {
      playsinline: 1,
      controls: 0,
      rel: 0,
      modestbranding: 1,
      iv_load_policy: 3,
      fs: 0,
      disablekb: 1,
      hl: 'ja',
      ...(settings.subs === 'ja' ? { cc_load_policy: 1, cc_lang_pref: 'ja' } : {}),
    },
    events: {
      onReady: () => { playerReady = true; updateStart(); },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED) autoNext();
        if (e.data === YT.PlayerState.PLAYING) { clearTimeout(watchdog); applyCaptions(); }
      },
      onApiChange: () => applyCaptions(), // 字幕の情報は再生が始まってから届く
      onError: () => { toast('再生できない動画をスキップしました'); next(); },
    },
  });
};

// 日本語字幕があればそれを、なければ他の字幕をYouTubeの自動翻訳で日本語にする。
// 字幕まわりは公式に文書化されていない機能なので、失敗しても再生には影響させない。
function applyCaptions() {
  if (settings.subs !== 'ja' || !player?.getOption) return;
  try {
    const list = player.getOption('captions', 'tracklist') || [];
    if (!list.length) return;
    const ja = list.find((t) => (t.languageCode || '').startsWith('ja'));
    const base = ja || list.find((t) => t.kind !== 'asr') || list[0];
    const want = ja
      ? { languageCode: ja.languageCode }
      : { languageCode: base.languageCode, translationLanguage: { languageCode: 'ja', languageName: '日本語' } };

    const cur = player.getOption('captions', 'track') || {};
    const curTl = cur.translationLanguage?.languageCode || '';
    const wantTl = want.translationLanguage?.languageCode || '';
    if (cur.languageCode === want.languageCode && curTl === wantTl) return;

    player.setOption('captions', 'track', want);
  } catch (e) {
    console.warn('字幕の設定に失敗', e);
  }
}

// 埋め込みのショートは終わると頭に戻ってループし、ENDED が来ないことがある。
// そのため再生位置を見張り、終わり際か、頭に巻き戻ったのを見つけたら次へ進む。
let current = null;
let advancedFor = null;
let maxTime = 0;
let endTimer = null;

// 寝落ち対策: 最後に画面を触ってから一定時間たったら、今の動画が終わったところで止める
let lastTouch = Date.now();
const touched = () => { lastTouch = Date.now(); };

function sleepDue() {
  return settings.sleepMin > 0 && Date.now() - lastTouch >= settings.sleepMin * 60 * 1000;
}

function autoNext() {
  if (!current || advancedFor === current.id) return;
  advancedFor = current.id;
  if (sleepDue()) {
    clearInterval(endTimer);
    player.pauseVideo();
    $('sleep').hidden = false;
    return;
  }
  next();
}

function watchEnd() {
  clearInterval(endTimer);
  maxTime = 0;
  endTimer = setInterval(() => {
    if (!player?.getCurrentTime || player.getPlayerState() !== YT.PlayerState.PLAYING) return;
    if (player.getVideoData?.().video_id !== current?.id) return; // 切り替え直後は前の動画の値が残っている
    const t = player.getCurrentTime();
    const d = player.getDuration() || current?.sec || 0;
    if (d > 0 && t >= d - 0.5) return autoNext();
    if (d > 0 && maxTime >= d * 0.7 && t < maxTime - 2) return autoNext(); // ループして頭に戻った
    maxTime = Math.max(maxTime, t);
  }, 300);
}

function play(video) {
  current = video;
  advancedFor = null;
  watchEnd();
  player.loadVideoById(video.id);
  $('title').textContent = video.title;
  $('channel').textContent = video.channel;
  $('btnOpen').href = 'https://www.youtube.com/shorts/' + video.id;

  if (!watchedSet.has(video.id)) {
    watchedSet.add(video.id);
    watched.push(video.id);
    if (watched.length > WATCHED_MAX) {
      watched = watched.slice(-WATCHED_MAX);
      watchedSet = new Set(watched);
    }
    store.set('watched', watched);

    recentTitles.push(normTitle(video.title));
    if (recentTitles.length > RECENT_TITLES_MAX) recentTitles = recentTitles.slice(-RECENT_TITLES_MAX);
    store.set('recentTitles', recentTitles);
  }

  // 音ありで自動再生できなかった時は、ミュートで再生して音出しボタンを出す
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    const s = player.getPlayerState();
    if (s !== YT.PlayerState.PLAYING && s !== YT.PlayerState.BUFFERING) {
      player.mute();
      player.playVideo();
      $('btnUnmute').hidden = false;
    }
  }, 3000);

  if (queue.length < REFILL_AT) refill();
}

async function next() {
  if (pos < history.length - 1) {
    play(history[++pos]);
    return;
  }
  if (!queue.length) await refill();

  // 直近に流したチャンネルと違うものを優先して選ぶ（なければ先頭）
  const recentCh = history.slice(-CHANNEL_GAP).map(channelKey);
  let i = queue.findIndex((x) => !recentCh.includes(channelKey(x)));
  if (i < 0) i = 0;
  const v = queue.splice(i, 1)[0];
  if (!v) {
    toast('流せる動画がなくなりました。\nキーワードを足すか、視聴履歴をリセットしてください。');
    return;
  }
  history.push(v);
  pos = history.length - 1;
  play(v);
}

function prev() {
  if (pos > 0) play(history[--pos]);
}

function togglePause() {
  if (!player) return;
  if (player.getPlayerState() === YT.PlayerState.PLAYING) player.pauseVideo();
  else player.playVideo();
}

// ---------- 画面 ----------
let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.style.whiteSpace = 'pre-line';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

function updateStart() {
  const btn = $('btnStart');
  const msg = $('startMsg');
  if (!settings.apiKey || !sources.length) {
    msg.textContent = 'まず設定でAPIキーとキーワードかチャンネルを登録してください。';
    btn.disabled = true;
  } else if (!playerReady || refilling) {
    msg.textContent = '読み込み中…';
    btn.disabled = true;
  } else if (!queue.length) {
    msg.textContent = '動画が見つかりませんでした。設定を見直してください。';
    btn.disabled = true;
  } else {
    msg.textContent = queue.length + '本以上の動画を用意しました。';
    btn.disabled = false;
  }
}

function openSettings() {
  $('inKey').value = settings.apiKey;
  $('inKeywords').value = settings.keywords.join('\n');
  $('inChannels').value = settings.channels.join('\n');
  $('inOrder').value = settings.order;
  $('inPeriod').value = settings.period;
  $('inMaxSec').value = String(settings.maxSec);
  $('inSleep').value = String(settings.sleepMin);
  $('inSubs').value = settings.subs;
  $('inNg').value = settings.ngWords.join('\n');
  $('inBlocked').value = settings.blocked.map((b) => `${b.name} [${b.key}]`).join('\n');
  const q = store.get('quota', null);
  const today = new Date().toISOString().slice(0, 10);
  const used = q && q.day === today ? q.used : 0;
  $('quota').textContent = `今日のAPI使用量（目安）: ${used} / 10000（検索1回=100）`;
  $('settings').hidden = false;
  if (player && started) player.pauseVideo();
}

function lines(text) {
  return [...new Set(text.split('\n').map((s) => s.trim()).filter(Boolean))];
}

async function reload() {
  buildSources();
  history = history.slice(0, pos + 1);
  updateStart();
  await refill();
  updateStart();
}

$('btnSave').onclick = async () => {
  settings.apiKey = $('inKey').value.trim();
  settings.keywords = lines($('inKeywords').value);
  settings.channels = lines($('inChannels').value);
  settings.order = $('inOrder').value;
  settings.period = $('inPeriod').value;
  settings.maxSec = Number($('inMaxSec').value);
  settings.sleepMin = Number($('inSleep').value);
  const subsChanged = settings.subs !== $('inSubs').value;
  settings.subs = $('inSubs').value;
  settings.ngWords = lines($('inNg').value);
  // 「名前 [キー]」の形。行を消せば非表示が解除される
  settings.blocked = lines($('inBlocked').value).map((l) => {
    const m = l.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
    return m ? { name: m[1], key: m[2] } : { name: l, key: l };
  });
  store.set('settings', settings);
  // 字幕の設定はプレイヤーを作る時にしか渡せないので、ページごと読み直す
  if (subsChanged) { location.reload(); return; }
  $('settings').hidden = true;
  started = false;
  if (player) player.stopVideo();
  $('start').hidden = false;
  await reload();
};

$('btnResetWatched').onclick = () => {
  if (!confirm('見た動画の記録を消して、また流れるようにしますか？')) return;
  watched = [];
  watchedSet = new Set();
  store.set('watched', watched);
  recentTitles = [];
  store.set('recentTitles', recentTitles);
  toast('視聴履歴をリセットしました');
};

$('btnBlock').onclick = () => {
  if (!current) return;
  const name = current.channel || '（不明）';
  if (!confirm(`「${name}」の動画を今後出さないようにしますか？\n（設定画面からいつでも戻せます）`)) return;
  settings.blocked.push({ name, key: channelKey(current) || name });
  store.set('settings', settings);
  queue = queue.filter((v) => !isBlocked(v));
  toast(`「${name}」を非表示にしました`);
  next();
};

$('btnClose').onclick = () => {
  $('settings').hidden = true;
  if (player && started) player.playVideo();
};

$('btnSettings').onclick = openSettings;
$('btnStartSettings').onclick = openSettings;

$('btnWake').onclick = () => {
  $('sleep').hidden = true;
  next();
};

// どこかを触ったら寝落ちタイマーを最初から数え直す
document.addEventListener('touchstart', touched, { passive: true, capture: true });
document.addEventListener('mousedown', touched, true);
document.addEventListener('keydown', touched, true);

$('btnStart').onclick = () => {
  started = true;
  $('start').hidden = true;
  next();
};

$('btnUnmute').onclick = () => {
  player.unMute();
  player.setVolume(100);
  player.playVideo();
  $('btnUnmute').hidden = true;
};

$('btnNext').onclick = () => next();
$('btnPrev').onclick = () => prev();

// スワイプ: 上へで次、下へで前、タップで一時停止
let touchY = null;
$('touch').addEventListener('touchstart', (e) => { touchY = e.touches[0].clientY; }, { passive: true });
$('touch').addEventListener('touchend', (e) => {
  if (touchY == null) return;
  e.preventDefault(); // 後から来る click で二重に反応しないように
  const dy = e.changedTouches[0].clientY - touchY;
  touchY = null;
  if (dy < -60) next();
  else if (dy > 60) prev();
  else togglePause();
});
$('touch').addEventListener('click', () => togglePause());

// PCで試す用
document.addEventListener('keydown', (e) => {
  if (!started || !$('settings').hidden) return;
  if (e.key === 'ArrowDown') next();
  else if (e.key === 'ArrowUp') prev();
  else if (e.key === ' ') { e.preventDefault(); togglePause(); }
});

// ---------- 起動 ----------
if (!settings.apiKey || (!settings.keywords.length && !settings.channels.length)) {
  buildSources();
  updateStart();
  openSettings();
} else {
  reload();
}
