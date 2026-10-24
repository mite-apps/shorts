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

const settings = Object.assign(
  { apiKey: '', keywords: [], channels: [], order: 'relevance', maxSec: 180 },
  store.get('settings', {})
);
let watched = store.get('watched', []);
let watchedSet = new Set(watched);

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

// ソース1つ分の次のページを取ってくる
async function fetchPage(src) {
  if (src.type === 'keyword') {
    const key = ['kw', src.q, settings.order, src.token].join('|');
    const json = await cached(key, () => yt('search', {
      part: 'snippet',
      q: src.q + ' #shorts',
      type: 'video',
      videoDuration: 'short',
      videoEmbeddable: 'true',
      regionCode: 'JP',
      order: settings.order,
      maxResults: 50,
      pageToken: src.token,
    }, 100).then(slimSearch));
    src.token = json.next || '';
    src.done = !json.next;
    return json.items;
  }

  // チャンネル: ショートだけの隠し再生リスト(UUSH...)を使い、駄目なら全動画(UU...)にする
  if (!src.channelId) src.channelId = await resolveChannelId(src.input);
  const prefix = src.fallback ? 'UU' : 'UUSH';
  const playlistId = prefix + src.channelId.slice(2);
  const key = ['pl', playlistId, src.token].join('|');
  try {
    const json = await cached(key, () => yt('playlistItems', {
      part: 'snippet',
      playlistId,
      maxResults: 50,
      pageToken: src.token,
    }, 1).then(slimPlaylist));
    src.token = json.next || '';
    src.done = !json.next;
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
    },
    events: {
      onReady: () => { playerReady = true; updateStart(); },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED) autoNext();
        if (e.data === YT.PlayerState.PLAYING) clearTimeout(watchdog);
      },
      onError: () => { toast('再生できない動画をスキップしました'); next(); },
    },
  });
};

// 埋め込みのショートは終わると頭に戻ってループし、ENDED が来ないことがある。
// そのため再生位置を見張り、終わり際か、頭に巻き戻ったのを見つけたら次へ進む。
let current = null;
let advancedFor = null;
let maxTime = 0;
let endTimer = null;

function autoNext() {
  if (!current || advancedFor === current.id) return;
  advancedFor = current.id;
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
  const v = queue.shift();
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
  $('inMaxSec').value = String(settings.maxSec);
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
  settings.maxSec = Number($('inMaxSec').value);
  store.set('settings', settings);
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
  toast('視聴履歴をリセットしました');
};

$('btnClose').onclick = () => {
  $('settings').hidden = true;
  if (player && started) player.playVideo();
};

$('btnSettings').onclick = openSettings;
$('btnStartSettings').onclick = openSettings;

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
