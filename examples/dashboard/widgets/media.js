// Mini now-playing: artwork, title, artist and a play/pause button.
// Needs "media" to read and "media.control" for the button.

import { $, setText, explain } from '../lib/util.js';

const READ_ERRORS = { EPERM: 'Needs the media permission' };
const CONTROL_ERRORS = { EPERM: 'Control not allowed', EUNAVAILABLE: 'Nothing to play' };

export function mountMedia() {
  const widget = $('media');
  let np = null;
  let artworkId;
  let noteTimer = 0;
  let lasting = '';  // why media cannot be read; a failed button press only covers it for a moment

  function note(text, isLasting) {
    clearTimeout(noteTimer);
    if (isLasting) lasting = text;
    setText('media-note', text || lasting);
    if (text && !isLasting) noteTimer = setTimeout(() => setText('media-note', lasting), 4000);
  }

  function show(next) {
    np = next || null;
    widget.dataset.state = !np ? 'empty' : np.playing ? 'playing' : 'paused';
    setText('media-title', np ? np.title || 'Unknown title' : 'Nothing playing');
    setText('media-artist', np ? [np.artist, np.album].filter(Boolean).join(' · ') : 'Press play to resume');
    $('media-toggle').setAttribute('aria-label', np && np.playing ? 'Pause' : 'Play');
    showArtwork(np ? np.artworkId : null);
  }

  // Artwork is fetched only when artworkId changes.
  async function showArtwork(id) {
    if (id === artworkId) return;
    artworkId = id;
    let url = null;
    if (id) url = await CarPWA.media.getArtwork(320).catch(() => null); // the music-note placeholder stays
    if (id !== artworkId) return;
    if (url) $('media-art').src = url; else $('media-art').removeAttribute('src');
    widget.classList.toggle('has-art', !!url);
  }

  async function load() {
    try {
      show(await CarPWA.media.getNowPlaying());
      note('', true);
    } catch (e) {
      show(null);
      setText('media-title', 'Media unavailable');
      setText('media-artist', '');
      note(explain(e, READ_ERRORS), true);
    }
  }

  $('media-toggle').addEventListener('click', async () => {
    try {
      await CarPWA.media.togglePlayPause();
    } catch (e) {
      note(explain(e, CONTROL_ERRORS));
    }
  });

  CarPWA.media.on('nowPlaying', show);
  CarPWA.media.on('playbackState', ({ playing }) => {
    if (np) show({ ...np, playing });
    else load(); // something started: fetch what it is
  });
  CarPWA.ui.on('foreground', load);
  load();
}
