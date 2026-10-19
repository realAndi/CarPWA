# civetweb (vendored)

HTTP + WebSocket server used by `carpwad`.

- Upstream: https://github.com/civetweb/civetweb
- Version: v1.16, commit d7ba35bbb649209c66e582d5a0244ba988a15159
- License: MIT (see LICENSE.md; only the core civetweb license applies, no
  optional components are compiled in)

Only the files needed for this build are copied: `civetweb.c`, `civetweb.h`
and the `.inl` files it includes unconditionally. Compiled with:

    -DNO_SSL -DNO_CGI -DUSE_WEBSOCKET

No local modifications. To update, replace these files from a newer tag and
re-run the daemon tests (`make -C Daemon test`).
