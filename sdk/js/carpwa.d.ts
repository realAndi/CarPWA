// Type definitions for the CarPWA SDK 1.0

export type ErrorCode =
  | 'EINVAL' | 'EPERM' | 'ENOTFOUND' | 'EUNAVAILABLE' | 'ENOTCAR' | 'ETIMEOUT' | 'EINTERNAL';

export interface CarPWAError extends Error {
  name: 'CarPWAError';
  code: ErrorCode | string;
  details?: unknown;
}

export type Unsubscribe = () => void;

export interface Rect { x: number; y: number; width: number; height: number; }
export interface Insets { top: number; left: number; bottom: number; right: number; }

export type Permission =
  | 'media' | 'media.control' | 'location' | 'network' | 'navigation'
  | 'vehicle.identity' | 'car.raw' | 'apps.launch';

// ------------------------------------------------------------------ car

export type FuelType = 'gasoline' | 'diesel' | 'electric' | 'cng';

export interface CarInfo {
  connected: boolean;
  name: string | null;
  model: string | null;
  manufacturer: string | null;
  firmwareVersion: string | null;
  hardwareVersion: string | null;
  /** Only with the `vehicle.identity` permission. */
  serialNumber?: string | null;
  fuelTypes: FuelType[];
  rightHandDrive: boolean;
  transport: 'wired' | 'wireless' | 'unknown';
  supportsACBack: boolean;
  supportsNightMode: boolean;
  supportsElectronicTollCollection: boolean;
  supportsDestinationSharing: boolean;
  displays: Array<{
    id: string | null;
    pixelSize: { width: number; height: number } | null;
    physicalSize: { width: number; height: number } | null;
    carPlay: boolean;
    instrumentCluster: boolean;
  }>;
}

export interface CarState {
  connected: boolean;
  nightMode: boolean;
  appearance: 'light' | 'dark';
  /** The car asks apps to reduce UI while driving. */
  limitedUI: boolean;
  limitedUIElements: { keyboard: boolean; lists: boolean; raw: number };
  /** The area of the car screen your app is drawn in, in points. */
  viewArea: Rect | null;
  safeArea: Insets;
  carOwnsScreen: boolean | null;
  carOwnsMainAudio: boolean | null;
  /** True when CarPWA's app is the one on screen. */
  visible: boolean;
}

export interface CarStateEvent { state: CarState; changed: Array<keyof CarState>; }

export interface CarEvents {
  state: CarStateEvent;
  nightMode: { nightMode: boolean };
  appearance: { appearance: 'light' | 'dark' };
  limitedUI: { limitedUI: boolean; limitedUIElements: CarState['limitedUIElements'] };
  viewArea: { viewArea: Rect | null; safeArea: Insets };
  connect: CarInfo;
  disconnect: Record<string, never>;
  /** `car.raw`: remote events the car sent that CarPlay did not handle. */
  remoteEvent: { event: string; payload: unknown };
  /** `car.raw`: the car asked the phone to open a URL. */
  openURL: { url: string };
}

// --------------------------------------------------------------- screen

export type InteractionModel = 'touch' | 'knob' | 'touchpad' | 'unknown';

export interface ScreenInfo {
  id: string | null;
  /** Size of your app's area, in CSS pixels. */
  width: number;
  height: number;
  scale: number;
  pixelWidth: number | null;
  pixelHeight: number | null;
  physicalWidthMM: number | null;
  physicalHeightMM: number | null;
  maxFPS: number | null;
  safeArea: Insets;
  interaction: {
    primary: InteractionModel;
    touch: boolean;
    knob: boolean;
    touchpad: boolean;
    highFidelityTouch: boolean;
    raw: { available: number; primary: number };
  };
}

// ---------------------------------------------------------------- media

export interface NowPlaying {
  title: string | null;
  artist: string | null;
  album: string | null;
  genre: string | null;
  /** Seconds. */
  duration: number | null;
  /** Seconds, as of `elapsedAt`. */
  elapsed: number | null;
  /** ms since epoch when `elapsed` was sampled. */
  elapsedAt: number | null;
  rate: number;
  playing: boolean;
  /** Changes whenever the artwork changes; pass to nothing, just compare. */
  artworkId: string | null;
  app: { bundleId: string | null; name: string | null };
}

export interface MediaEvents {
  nowPlaying: NowPlaying | null;
  playbackState: { playing: boolean };
}

// ------------------------------------------------------------ navigation

export interface NavState {
  navigating: boolean;
  /** Bundle ids of apps currently giving directions. */
  apps: string[];
  mostRecent: string | null;
  /** What the car reports as owning turn-by-turn, if known. */
  owner: unknown;
}

// -------------------------------------------------------------- location

export interface LocationFix {
  latitude: number;
  longitude: number;
  altitude: number | null;
  horizontalAccuracy: number;
  verticalAccuracy: number | null;
  /** m/s, null if unknown. */
  speed: number | null;
  /** Degrees from true north, null if unknown. */
  course: number | null;
  timestamp: number;
}

// ----------------------------------------------------------------- input

export type MoveDirection = 'up' | 'down' | 'left' | 'right' | 'next' | 'previous';

export interface InputEvents {
  /** Knob rotation (`next`/`previous`), knob nudges, touchpad swipes, D-pad. */
  move: { direction: MoveDirection };
  select: { phase: 'down' | 'up' };
  /** Only delivered while `interceptBack(true)` is on. */
  back: Record<string, never>;
}

// -------------------------------------------------------------------- ui

export interface AlertAction { id: string; title: string; style?: 'default' | 'cancel' | 'destructive'; }
export interface AlertOptions { title?: string; message?: string; actions?: AlertAction[]; }
export interface BannerOptions { title: string; subtitle?: string; duration?: number; }

export interface UIEvents {
  foreground: Record<string, never>;
  background: Record<string, never>;
}

// ------------------------------------------------------------------ apps

export interface CarPWAAppEntry {
  id: string;
  name: string;
  version: string;
  port: number;
  url: string;
}

export interface CarPlayAppEntry { bundleId: string; name: string | null; }

// --------------------------------------------------------------- storage

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// ------------------------------------------------------------------- net

export interface ProxyFetchInit {
  method?: string;
  headers?: HeadersInit;
  body?: string | URLSearchParams | ArrayBuffer | ArrayBufferView | Blob | Json;
  /** Seconds. Default 30. */
  timeout?: number;
}

export interface ProxyResponse {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: Headers;
  text(): Promise<string>;
  json<T = any>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
}

// ---------------------------------------------------------------- module

export interface Env {
  mode: 'carplay' | 'simulator' | 'browser';
  isCarPlay: boolean;
  appId: string | null;
  carpwaVersion: string | null;
  devMode: boolean;
  /** True while the WebSocket to carpwad is up. */
  server: boolean;
}

export interface FocusOptions {
  /** CSS selector for focusable elements. */
  selector?: string;
  /** Class added to the focused element. Default `carpwa-focused`. */
  className?: string;
  /** Wrap around at the ends when rotating the knob. Default true. */
  wrap?: boolean;
  /** Restrict to a subtree. */
  root?: Element | Document | null;
  /** Selector for the first element to focus, or `false` to focus nothing. */
  initial?: string | false;
}

type On<E> = <K extends keyof E>(event: K, fn: (data: E[K]) => void) => Unsubscribe;
type Off<E> = <K extends keyof E>(event: K, fn: (data: E[K]) => void) => void;

export interface CarPWA {
  readonly version: string;
  readonly Error: { new (code: string, message?: string): CarPWAError };
  config: { autoReload: boolean; theme: boolean; forwardConsole: boolean };
  readonly env: Env;
  readonly state: { car: CarState | null; screen: ScreenInfo | null };

  ready(): Promise<Env>;
  call<T = any>(module: string, method: string, params?: Record<string, unknown>): Promise<T>;
  on(module: string, event: string, fn: (data: any) => void): Unsubscribe;
  off(module: string, event: string, fn: (data: any) => void): void;
  once(module: string, event: string, fn: (data: any) => void): Unsubscribe;
  modules(): Promise<Array<{ name: string; methods: string[]; events: string[]; permission: string | null }>>;

  car: {
    getInfo(): Promise<CarInfo>;
    getState(): Promise<CarState>;
    /** `car.raw`. Sends a raw session command to the head unit. */
    sendCommand(command: string, parameters?: Record<string, unknown>): Promise<boolean>;
    /** `car.raw`. Asks the head unit to show its own (OEM) UI. */
    requestCarUI(url?: string | null): Promise<boolean>;
    readonly state: CarState | null;
    on: On<CarEvents>;
    off: Off<CarEvents>;
  };

  screen: {
    getInfo(): Promise<ScreenInfo>;
    readonly info: ScreenInfo | null;
    on: On<{ change: ScreenInfo }>;
    off: Off<{ change: ScreenInfo }>;
  };

  media: {
    /** `media`. Null when nothing is playing. */
    getNowPlaying(): Promise<NowPlaying | null>;
    /** `media`. A data: URL (JPEG), or null. */
    getArtwork(size?: number): Promise<string | null>;
    play(): Promise<boolean>;
    pause(): Promise<boolean>;
    togglePlayPause(): Promise<boolean>;
    stop(): Promise<boolean>;
    next(): Promise<boolean>;
    previous(): Promise<boolean>;
    /** Absolute position in seconds. */
    seek(position: number): Promise<boolean>;
    /** Relative, e.g. `skip(15)` or `skip(-15)`. */
    skip(seconds: number): Promise<boolean>;
    on: On<MediaEvents>;
    off: Off<MediaEvents>;
  };

  nav: {
    getState(): Promise<NavState>;
    requestOwnership(): Promise<boolean>;
    releaseOwnership(): Promise<boolean>;
    on: On<{ change: NavState }>;
    off: Off<{ change: NavState }>;
  };

  location: {
    getCurrent(options?: { timeout?: number; maxAge?: number }): Promise<LocationFix>;
    watch(fn: (fix: LocationFix) => void): Unsubscribe;
    on: On<{ update: LocationFix; error: { code: string; message: string } }>;
    off: Off<{ update: LocationFix; error: { code: string; message: string } }>;
  };

  input: {
    /** `app`: knob/touchpad/D-pad become `move`/`select` events. `native`: WebKit handles them. */
    setCaptureMode(mode: 'app' | 'native'): Promise<boolean>;
    interceptBack(enabled?: boolean): Promise<boolean>;
    on: On<InputEvents>;
    off: Off<InputEvents>;
  };

  ui: {
    /** Back to the CarPlay home screen. The page stays alive in the background. */
    close(): Promise<boolean>;
    /** Resolves with the id of the chosen action. */
    alert(options: AlertOptions): Promise<string | null>;
    banner(options: BannerOptions | string): Promise<boolean>;
    setBackgroundColor(color: string): Promise<boolean>;
    on: On<UIEvents>;
    off: Off<UIEvents>;
  };

  apps: {
    list(): Promise<{ carpwa: CarPWAAppEntry[]; carplay: CarPlayAppEntry[] }>;
    /** `apps.launch`. A CarPWA app id or a CarPlay app bundle id. */
    open(id: string): Promise<boolean>;
    /** `apps.launch`. */
    openURL(url: string): Promise<boolean>;
  };

  system: {
    info(): Promise<{
      carpwaVersion: string; iosVersion: string; device: string;
      locale: string; timeZone: string; devMode: boolean; plugins: string[];
    }>;
    log(message: string, level?: 'debug' | 'info' | 'error' | 'fault'): Promise<boolean>;
  };

  app: {
    info(): Promise<{ id: string; name: string; version: string; port: number; permissions: Permission[]; origin: 'system' | 'user' }>;
    list(): Promise<CarPWAAppEntry[]>;
    on(event: 'serverConnected' | 'serverDisconnected', fn: () => void): Unsubscribe;
    off(event: 'serverConnected' | 'serverDisconnected', fn: () => void): void;
  };

  storage: {
    get<T extends Json = Json>(key: string): Promise<T | null>;
    set(key: string, value: Json): Promise<true>;
    remove(key: string): Promise<true>;
    keys(): Promise<string[]>;
    getAll(): Promise<Record<string, Json>>;
    clear(): Promise<true>;
    onChange(fn: (change: { key: string | null; value: Json }) => void): Unsubscribe;
  };

  channel(name: string): {
    readonly name: string;
    /** Resolves with the number of receivers. */
    publish(data: Json): Promise<number>;
    subscribe(fn: (data: Json, message: { channel: string; data: Json; from: string }) => void): Unsubscribe;
  };

  net: {
    /** `network`. fetch() through carpwad: no CORS, hosts limited to `network.allow`. */
    fetch(url: string, init?: ProxyFetchInit): Promise<ProxyResponse>;
  };

  focus: {
    enable(options?: FocusOptions): void;
    disable(): void;
    move(direction: MoveDirection): void;
    set(el: Element | null): void;
    readonly current: Element | null;
  };
}

declare const CarPWA: CarPWA;
export default CarPWA;

declare global {
  interface Window { CarPWA: CarPWA; }
}
