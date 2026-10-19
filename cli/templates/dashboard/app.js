// {{NAME}}: a glanceable dashboard with a clock and what's playing.
// The 12/24-hour setting lives in CarPWA.storage, so it survives restarts and
// stays in sync across every open page of this app.

const $ = (id) => document.getElementById(id);
const settings = { clock24: false };
let nowPlaying = null;

function renderClock() {
  const now = new Date();
  $('clock').textContent = now.toLocaleTimeString([], {
    hour: settings.clock24 ? '2-digit' : 'numeric',
    minute: '2-digit',
    hourCycle: settings.clock24 ? 'h23' : 'h12',
  }).replace(/\s?[AP]M$/i, '');
  $('date').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const h = now.getHours();
  $('greeting').textContent = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function renderSetting() {
  $('format').setAttribute('aria-checked', String(settings.clock24));
  renderClock();
}

async function renderNowPlaying(np) {
  const previousArt = nowPlaying && nowPlaying.artworkId;
  nowPlaying = np;
  $('now').dataset.state = !np ? 'empty' : np.playing ? 'playing' : 'paused';
  $('now-title').textContent = np ? np.title || 'Unknown title' : 'Nothing playing';
  $('now-artist').textContent = np ? np.artist || np.app.name || '' : 'Music from your phone shows up here.';
  renderProgress();

  if (!np || !np.artworkId) { $('thumb').style.backgroundImage = ''; return; }
  if (np.artworkId === previousArt) return;
  const url = await CarPWA.media.getArtwork(160).catch(() => null);
  $('thumb').style.backgroundImage = url ? `url("${url}")` : '';
}

function renderProgress() {
  const np = nowPlaying;
  if (!np || !np.duration) { $('fill').style.width = '0%'; return; }
  const drift = np.playing && np.elapsedAt ? (Date.now() - np.elapsedAt) / 1000 * (np.rate || 1) : 0;
  $('fill').style.width = `${Math.min(100, ((np.elapsed || 0) + drift) / np.duration * 100)}%`;
}

async function main() {
  const env = await CarPWA.ready();
  renderClock();
  setInterval(() => { renderClock(); renderProgress(); }, 1000);

  // ---- setting backed by CarPWA.storage
  if (env.server) {
    settings.clock24 = (await CarPWA.storage.get('clock24')) === true;
    CarPWA.storage.onChange(({ key, value }) => {
      if (key === 'clock24' || key === null) { settings.clock24 = value === true; renderSetting(); }
    });
  }
  renderSetting();
  $('format').addEventListener('click', async () => {
    settings.clock24 = !settings.clock24;
    renderSetting();
    if (env.server) await CarPWA.storage.set('clock24', settings.clock24);
  });

  if (env.mode === 'browser') return;

  // ---- now playing (needs the "media" permission)
  CarPWA.focus.enable({ initial: false });
  CarPWA.media.on('nowPlaying', renderNowPlaying);
  try {
    renderNowPlaying(await CarPWA.media.getNowPlaying());
  } catch (err) {
    $('now-artist').textContent = err.code === 'EPERM' ? 'Add "media" to permissions in carpwa.json.' : err.message;
  }
}

main().catch((err) => console.error('startup failed', err));
