// Now Playing: a full-screen player for whatever the phone is playing.
// Reading needs the "media" permission; the buttons need "media.control".
//
// The progress bar never polls. NowPlaying carries `elapsed` as sampled at
// `elapsedAt` plus the playback `rate`, so the position is extrapolated every
// animation frame and re-based whenever the phone reports something new.

const $ = (id) => document.getElementById(id);
const player = $('player');

let np = null;          // the NowPlaying on screen, or null
let artworkId;          // artworkId whose image is on screen (undefined: none asked for yet)
let frame = 0;          // requestAnimationFrame handle
let shownSecond = -1;   // last whole second written to the time labels
let resumeAction = null; // what the empty-state button does: 'play' | 'retry'
let resyncTimer = 0;
let toastTimer = 0;

const READ_ERRORS = {
  ENOTCAR: ['Not on CarPlay', 'Open this app on the car screen, or run it with carpwa sim.'],
  EPERM: ['Can’t see what’s playing', 'This app doesn’t have the media permission.'],
  EUNAVAILABLE: ['Media isn’t available', 'Try again in a moment.'],
  ETIMEOUT: ['The phone didn’t answer', 'Try again in a moment.'],
};
const CONTROL_ERRORS = {
  ENOTCAR: 'Not on CarPlay',
  EPERM: 'This app isn’t allowed to control playback',
  EUNAVAILABLE: 'Nothing to control right now',
  ETIMEOUT: 'The phone didn’t answer',
};
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const knobFirst = () => ['knob', 'touchpad'].includes(CarPWA.screen.info?.interaction.primary);

// ------------------------------------------------------------- position

function fmt(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function position(n) {
  if (!n || n.elapsed == null) return 0;
  let pos = n.elapsed;
  if (n.playing && n.elapsedAt) pos += ((Date.now() - n.elapsedAt) / 1000) * (n.rate || 1);
  return Math.max(0, n.duration ? Math.min(pos, n.duration) : pos);
}

// A copy of `n` sampled now, so later changes extrapolate from this moment.
const rebase = (n, patch) => ({ ...n, elapsed: position(n), elapsedAt: Date.now(), ...patch });
const skipped = (n, by) => rebase(n, { elapsed: Math.max(0, Math.min(position(n) + by, n.duration || Infinity)) });

function draw() {
  const pos = position(np);
  const dur = Math.round((np && np.duration) || 0);
  $('fill').style.transform = `scaleX(${dur ? Math.min(1, pos / dur) : 0})`;
  const second = Math.floor(pos);
  if (second === shownSecond) return;
  shownSecond = second;
  $('elapsed').textContent = fmt(second);
  $('remaining').textContent = `-${fmt(dur - second)}`;
}

// One frame when paused; every frame while playing.
function animate() {
  cancelAnimationFrame(frame);
  const step = () => {
    draw();
    if (np && np.playing && np.duration) frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}

// -------------------------------------------------------------- render

function render(next) {
  np = next || null;
  if (!np) {
    showEmpty('Nothing playing', 'Start something on your phone, or pick up where you left off.', 'play');
  } else {
    player.dataset.state = np.playing ? 'playing' : 'paused';
    $('title').textContent = np.title || 'Unknown title';
    $('artist').textContent = np.artist || '';
    $('album').textContent = np.album || '';
    $('source').textContent = np.app && np.app.name ? `From ${np.app.name}` : '';
    $('play').setAttribute('aria-label', np.playing ? 'Pause' : 'Play');
    // Live radio has no duration: no bar, nothing to skip within.
    $('progress').hidden = !np.duration;
    $('back15').disabled = $('fwd15').disabled = !np.duration;
  }
  showArtwork(np ? np.artworkId : null);
  shownSecond = -1;
  animate();
  keepFocus();
}

function showEmpty(title, note, action) {
  player.dataset.state = 'empty';
  $('empty-title').textContent = title;
  $('empty-note').textContent = note;
  resumeAction = action;
  $('resume').hidden = !action;
  $('resume').textContent = action === 'play' ? 'Play' : 'Try again';
}

// Artwork is fetched only when artworkId changes, at the size it is drawn.
async function showArtwork(id) {
  if (id === artworkId) return;
  artworkId = id;
  let url = null;
  if (id) {
    const px = Math.min(1024, Math.ceil((($('art-box').clientWidth || 480) * devicePixelRatio) / 64) * 64);
    try {
      url = await CarPWA.media.getArtwork(px);
      if (url) { const img = new Image(); img.src = url; await img.decode(); }
    } catch {
      url = null; // the placeholder stays; nothing more to tell the driver
    }
  }
  if (id !== artworkId) return; // a newer track arrived while this one loaded
  const img = $('art');
  if (url) img.src = url; else img.removeAttribute('src');
  $('backdrop').style.backgroundImage = url ? `url("${url}")` : 'none';
  document.body.classList.toggle('has-art', !!url);
  if (url && !reduceMotion.matches && img.animate) {
    img.animate([{ opacity: 0, transform: 'scale(0.98)' }, { opacity: 1, transform: 'none' }], { duration: 350, easing: 'ease-out' });
  }
}

function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4000);
}

// Knob focus must sit on something visible when the screen swaps between the
// player and the empty state, or a button gets disabled. On knob-first cars
// something is always focused; on touch cars only once the knob was used.
function keepFocus() {
  const current = CarPWA.focus.current;
  if (current ? current.offsetParent !== null && !current.disabled : !knobFirst()) return;
  CarPWA.focus.set([$('play'), $('resume')].find((el) => el.offsetParent !== null) || null);
}

// ------------------------------------------------------------- loading

async function refresh() {
  try {
    render(await CarPWA.media.getNowPlaying());
  } catch (e) {
    np = null;
    cancelAnimationFrame(frame);
    const [title, note] = READ_ERRORS[e.code] || ['Something went wrong', e.message];
    showEmpty(title, note, e.code === 'ENOTCAR' || e.code === 'EPERM' ? null : 'retry');
    keepFocus();
  }
}

// ------------------------------------------------------------ controls

// Shows the expected result at once, then lets the phone's events confirm it.
async function control(action, guess) {
  const before = np;
  const expected = before && guess ? guess(before) : null;
  if (expected) render(expected);
  try {
    await action();
  } catch (e) {
    if (expected && np === expected) render(before);
    toast(CONTROL_ERRORS[e.code] || e.message || 'That didn’t work');
  }
}

const media = CarPWA.media;
$('play').addEventListener('click', () => control(() => media.togglePlayPause(), (n) => rebase(n, { playing: !n.playing })));
$('prev').addEventListener('click', () => control(() => media.previous()));
$('next').addEventListener('click', () => control(() => media.next()));
$('back15').addEventListener('click', () => control(() => media.skip(-15), (n) => skipped(n, -15)));
$('fwd15').addEventListener('click', () => control(() => media.skip(15), (n) => skipped(n, 15)));
$('resume').addEventListener('click', () => {
  if (resumeAction === 'play') control(() => media.play()).then(refresh);
  else refresh();
});

// -------------------------------------------------------------- events

media.on('nowPlaying', render);

// playbackState carries no position: freeze or restart the clock locally,
// then ask for the authoritative NowPlaying once things settle.
media.on('playbackState', ({ playing }) => {
  if (np && np.playing !== playing) render(rebase(np, { playing }));
  clearTimeout(resyncTimer);
  resyncTimer = setTimeout(refresh, 400);
});

// The page keeps running while another CarPlay app is on screen.
CarPWA.ui.on('background', () => cancelAnimationFrame(frame));
CarPWA.ui.on('foreground', refresh);

CarPWA.focus.enable({ initial: false });
refresh();
