// Mock media player: a small library, a playhead that advances in real time,
// generated artwork, and NowPlaying objects shaped exactly like carpwa.d.ts.

export const SOURCES = {
  'com.apple.Music': 'Music',
  'com.apple.podcasts': 'Podcasts',
  'com.spotify.client': 'Spotify',
};

export const LIBRARY = [
  { title: 'Night Drive', artist: 'Neon Avenue', album: 'Interstate Lights', genre: 'Synthwave', duration: 214, colors: ['#ff3cac', '#784ba0', '#2b86c5'], shape: 'sun' },
  { title: 'Coastal Highway', artist: 'The Overpasses', album: 'Mile Markers', genre: 'Indie Rock', duration: 187, colors: ['#f9d423', '#ff4e50', '#7a1f3d'], shape: 'waves' },
  { title: 'Rain on the Windshield', artist: 'Mara Ellis', album: 'Wipers', genre: 'Singer/Songwriter', duration: 243, colors: ['#4facfe', '#00f2fe', '#1b2a49'], shape: 'drops' },
  { title: 'Open Road (Extended Mix)', artist: 'Kilometre Zero', album: 'Cruise Control', genre: 'Electronic', duration: 352, colors: ['#43e97b', '#38f9d7', '#0b3d2e'], shape: 'road' },
  { title: 'Rest Stop', artist: 'Low Gear Trio', album: 'Idle', genre: 'Jazz', duration: 168, colors: ['#fddb92', '#d1fdff', '#5c4b8a'], shape: 'circles' },
  { title: 'Episode 42: Range Anxiety', artist: 'The Commute Show', album: 'The Commute Show', genre: 'Podcast', duration: 1830, colors: ['#a18cd1', '#fbc2eb', '#3a1c71'], shape: 'mic' },
];

export class MediaPlayer {
  constructor(onChange) {
    this.onChange = onChange;   // (kind: 'track'|'state'|'seek', np) => void
    this.index = -1;            // -1: nothing playing
    this.playing = false;
    this.elapsed = 0;
    this.elapsedAt = Date.now();
    this.source = 'com.apple.Music';
    this.artCache = new Map();
    setInterval(() => this.tick(), 250);
  }

  get track() { return this.index >= 0 ? LIBRARY[this.index] : null; }

  position() {
    if (!this.track) return 0;
    const p = this.elapsed + (this.playing ? (Date.now() - this.elapsedAt) / 1000 : 0);
    return Math.min(p, this.track.duration);
  }

  nowPlaying() {
    const t = this.track;
    if (!t) return null;
    return {
      title: t.title,
      artist: t.artist,
      album: t.album,
      genre: t.genre,
      duration: t.duration,
      elapsed: Math.round(this.position() * 1000) / 1000,
      elapsedAt: Date.now(),
      rate: this.playing ? 1 : 0,
      playing: this.playing,
      artworkId: `sim-${this.index}-${t.rev || 0}`,
      app: { bundleId: this.source, name: SOURCES[this.source] || null },
    };
  }

  freeze() {
    this.elapsed = this.position();
    this.elapsedAt = Date.now();
  }

  load(index, autoplay = true) {
    this.index = ((index % LIBRARY.length) + LIBRARY.length) % LIBRARY.length;
    this.elapsed = 0;
    this.elapsedAt = Date.now();
    this.playing = autoplay;
    this.onChange('track', this.nowPlaying());
  }

  play() {
    if (!this.track) { this.load(0, true); return; }
    if (this.playing) return;
    this.freeze();
    this.playing = true;
    this.onChange('state', this.nowPlaying());
  }

  pause() {
    if (!this.track || !this.playing) return;
    this.freeze();
    this.playing = false;
    this.onChange('state', this.nowPlaying());
  }

  toggle() { if (this.playing) this.pause(); else this.play(); }

  stop() {
    if (!this.track) return;
    this.index = -1;
    this.playing = false;
    this.elapsed = 0;
    this.onChange('track', null);
  }

  next() { this.load((this.index < 0 ? -1 : this.index) + 1, this.playing || this.index < 0); }

  // Like iOS: "previous" restarts the track unless you are in its first 3 seconds.
  previous() {
    if (this.position() > 3) { this.seek(0); return; }
    this.load(this.index - 1, this.playing);
  }

  seek(position) {
    if (!this.track) return;
    this.elapsed = Math.max(0, Math.min(this.track.duration, position));
    this.elapsedAt = Date.now();
    this.onChange('seek', this.nowPlaying());
  }

  /**
   * The inspector's now-playing editor: changes the current track's title,
   * artist, album or duration (loading the first track, paused, when nothing
   * is playing) and announces it like a real track change.
   */
  edit(fields) {
    if (!this.track) this.load(0, false);
    const t = this.track;
    this.freeze();
    // Empty fields keep their current value.
    for (const k of ['title', 'artist', 'album']) if (typeof fields[k] === 'string' && fields[k].trim()) t[k] = fields[k].trim();
    if (Number.isFinite(fields.duration) && fields.duration > 0) t.duration = Math.round(fields.duration);
    t.rev = (t.rev || 0) + 1;
    this.elapsed = Math.min(this.elapsed, t.duration);
    for (const key of [...this.artCache.keys()]) if (key.startsWith(`${this.index}@`)) this.artCache.delete(key);
    this.onChange('track', this.nowPlaying());
  }

  setSource(bundleId) {
    this.source = bundleId;
    if (this.track) this.onChange('seek', this.nowPlaying());
  }

  tick() {
    if (this.track && this.playing && this.position() >= this.track.duration) this.next();
  }

  /** A JPEG data: URL of the current artwork at `size` px, or null. */
  artwork(size = 512) {
    const t = this.track;
    if (!t) return null;
    size = Math.max(32, Math.min(2048, Math.round(Number(size) || 512)));
    const key = `${this.index}@${size}`;
    if (!this.artCache.has(key)) this.artCache.set(key, drawArtwork(t, size));
    return this.artCache.get(key);
  }
}

export function drawArtwork(track, size) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const s = size / 100;
  const [a, b, c] = track.colors;
  const grad = g.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, a);
  grad.addColorStop(0.55, b);
  grad.addColorStop(1, c);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);

  g.save();
  g.globalAlpha = 0.9;
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineCap = 'round';
  switch (track.shape) {
    case 'sun': {
      g.beginPath(); g.arc(50 * s, 52 * s, 24 * s, Math.PI, 0); g.fill();
      g.fillStyle = c;
      for (let i = 0; i < 5; i++) g.fillRect(24 * s, (36 + i * 4.2) * s, 52 * s, (1 + i * 0.5) * s);
      g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 0.8 * s;
      for (let i = 0; i < 7; i++) { g.beginPath(); g.moveTo(50 * s, 60 * s); g.lineTo((i * 16.6) * s, 100 * s); g.stroke(); }
      for (let y = 64; y < 100; y += (y - 56) / 3) { g.beginPath(); g.moveTo(0, y * s); g.lineTo(size, y * s); g.stroke(); }
      break;
    }
    case 'waves':
      g.lineWidth = 3.2 * s;
      for (let row = 0; row < 5; row++) {
        g.beginPath();
        for (let x = -5; x <= 105; x += 2) g.lineTo(x * s, (42 + row * 9 + Math.sin(x / 7 + row) * 3) * s);
        g.stroke();
      }
      break;
    case 'drops':
      for (let i = 0; i < 26; i++) {
        const x = (i * 37) % 100; const y = (i * 53) % 100; const r = 1.5 + (i % 4);
        g.globalAlpha = 0.25 + (i % 3) * 0.2;
        g.beginPath(); g.arc(x * s, y * s, r * s, 0, Math.PI * 2); g.fill();
      }
      break;
    case 'road':
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.beginPath(); g.moveTo(44 * s, 30 * s); g.lineTo(56 * s, 30 * s); g.lineTo(92 * s, 100 * s); g.lineTo(8 * s, 100 * s); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.9)';
      for (let i = 0; i < 5; i++) { const y = 34 + i * i * 3.2; g.fillRect((49.3 - i * 0.4) * s, y * s, (1.4 + i * 0.8) * s, (2 + i * 1.6) * s); }
      break;
    case 'circles':
      g.lineWidth = 2.4 * s;
      for (let r = 8; r < 60; r += 9) { g.beginPath(); g.arc(30 * s, 70 * s, r * s, 0, Math.PI * 2); g.stroke(); }
      break;
    case 'mic':
      g.beginPath(); g.roundRect(42 * s, 22 * s, 16 * s, 30 * s, 8 * s); g.fill();
      g.lineWidth = 3 * s;
      g.beginPath(); g.arc(50 * s, 44 * s, 15 * s, 0, Math.PI); g.stroke();
      g.beginPath(); g.moveTo(50 * s, 59 * s); g.lineTo(50 * s, 70 * s); g.stroke();
      break;
  }
  g.restore();

  // Title block, like a record sleeve.
  g.fillStyle = 'rgba(0,0,0,0.28)';
  g.fillRect(0, 78 * s, size, 22 * s);
  g.fillStyle = '#fff';
  g.font = `700 ${6.4 * s}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
  g.textBaseline = 'middle';
  g.fillText(track.album.toUpperCase(), 6 * s, 86 * s, 88 * s);
  g.font = `500 ${4.6 * s}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
  g.globalAlpha = 0.8;
  g.fillText(track.artist, 6 * s, 93.5 * s, 88 * s);
  return canvas.toDataURL('image/jpeg', 0.86);
}
