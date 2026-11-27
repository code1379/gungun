# Third-party components

Gungun packages the following upstream binary for proxy connection testing and chain execution:

- Mihomo v1.19.34 — https://github.com/MetaCubeX/mihomo/tree/v1.19.34
  - License: GNU General Public License v3.0
  - License text: https://github.com/MetaCubeX/mihomo/blob/v1.19.34/LICENSE
  - Corresponding source: https://github.com/MetaCubeX/mihomo/archive/refs/tags/v1.19.34.tar.gz
  - Gungun does not modify this upstream binary. Download integrity is checked against the upstream release asset SHA256 digest.

Electron and JavaScript dependency notices are retained in their packaged distributions.

fq can download official sing-box, Caddy and cloudflared releases on the user's VPS. Their source repositories and license notices are available at https://github.com/SagerNet/sing-box, https://github.com/caddyserver/caddy and https://github.com/cloudflare/cloudflared.

## shadcn/ui Base UI source components

The desktop button is adapted from shadcn/ui's Base UI registry and retains Gungun's visual tokens. Source: https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/ui/button.tsx

MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
