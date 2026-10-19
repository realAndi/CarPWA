// {{NAME}}: a now-playing screen for whatever the phone is playing.
// Needs the "media" (read) and "media.control" (buttons) permissions.
// Knob and touchpad cars move focus between the buttons via CarPWA.focus.

const $ = (id) => document.getElementById(id);
let current = null;      // last NowPlaying, or null
let artworkId = null;    // artwork currently shown

function fmt(seconds) {
  if (seconds == null || !isFinite(seconds)) return '0:00';
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// `elapsed` was sampled at `elapsedAt`; extrapolate with the playback rate.
function position(np) {
  if (!np || np.elapsed == null) return 0;
  const drift = np.playing && np.elapsedAt ? ((Date.now() - np.elapsedAt) / 1000) * (np.rate || 1) : 0;
  return Math.min(np.duration || Infinity, np.elapsed + drift);
}

async function render(np) {
  current = np;
  $('player').dataset.state = !np ? 'empty' : np.playing ? 'playing' : 'paused';
  $('title').textContent = np ? np.title || 'Unknown title' : 'Nothing playing';
  $('artist').textContent = np
    ? [np.artist, np.album].filter(Boolean).join(' — ') || ' '
    : 'Start something on your phone, or press play.';
  $('source').textContent = np && np.app && np.app.name ? `Playing from ${np.app.name}` : document.title;
  $('play').setAttribute('aria-label', np && np.playing ? 'Pause' : 'Play');
  tick();

  const nextArt = np ? np.artworkId : null;
  if (nextArt === artworkId) return;
  artworkId = nextArt;
  const url = nextArt ? await CarPWA.media.getArtwork(600).catch(() => null) : null;
  if (artworkId !== nextArt) return; // a newer track arrived meanwhile
  $('art').hidden = !url;
  $('art-placeholder').hidden = !!url;
  if (url) $('art').src = url;
}

function tick() {
  const np = current;
  const pos = position(np);
  const dur = np && np.duration ? np.duration : 0;
  $('fill').style.width = dur ? `${(pos / dur) * 100}%` : '0%';
  $('elapsed').textContent = fmt(pos);
  $('remaining').textContent = `–${fmt(dur - pos)}`;
}

function notice(text) {
  $('notice').textContent = text;
  $('notice').hidden = !text;
}

async function press(action) {
  try {
    await action();
    notice('');
  } catch (err) {
    notice(err.code === 'EPERM' ? 'Add "media.control" to permissions in carpwa.json.' : err.message);
  }
}

async function main() {
  const env = await CarPWA.ready();
  if (env.mode === 'browser') {
    notice('Open this app with `carpwa sim` or on the CarPlay screen to see what is playing.');
    return;
  }

  $('prev').addEventListener('click', () => press(() => CarPWA.media.previous()));
  $('next').addEventListener('click', () => press(() => CarPWA.media.next()));
  $('play').addEventListener('click', () => press(() =>
    current ? CarPWA.media.togglePlayPause() : CarPWA.media.play()));

  // Rotating the knob or swiping the touchpad moves the focus ring; pressing selects.
  CarPWA.focus.enable({ initial: '#play' });

  CarPWA.media.on('nowPlaying', render);
  CarPWA.media.on('playbackState', ({ playing }) => {
    if (current) render({ ...current, playing, elapsed: position(current), elapsedAt: Date.now() });
  });

  try {
    render(await CarPWA.media.getNowPlaying());
  } catch (err) {
    notice(err.code === 'EPERM' ? 'Add "media" to permissions in carpwa.json.' : `Media unavailable: ${err.message}`);
  }
  setInterval(tick, 500);
}

main().catch((err) => console.error('startup failed', err));
