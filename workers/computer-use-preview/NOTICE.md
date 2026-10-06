# Fixed executor third-party provenance

The running executor uses Python 3.11, Playwright 1.62.0 (Apache-2.0), and
cua-driver 0.34.0 (MIT). It imports no provider/model SDK.

The Windows x64 cua-driver 0.34.0 published wheel is pinned to SHA-256
`ecb2272eb3ac70399498934f7fc7166a4c6618ce5edcfe93563df30dbd23f66a`.
Its native DLL, matching driver executable and UI Automation helper are
distributed together, with its generated Python bindings. Published package
metadata identifies the license as MIT; source is pinned to the
`cua-driver-rs-v0.34.0` release at https://github.com/trycua/cua.

The published `cua_driver-0.34.0-py3-none-win_amd64.whl` was downloaded from
PyPI, its full wheel hash verified, and these resource hashes extracted from
the verified ZIP. Staging checks both source and collected resources:

| Resource | SHA-256 |
| --- | --- |
| `cua_driver_sdk.dll` | `1dae9015f81bb81b093b12181a1970b0a5cb1c2c992684afc1c629bdfc41728d` |
| `bin/cua-driver.exe` | `77f5cac754b42b6a8bae126414fc8f7487432ace93466967965188e24e9e53fb` |
| `bin/cua-driver-uia.exe` | `1c737385f3cf008240ca8ff2a58ffc6810ebd382c14bd3dccb87ccbdc4ced556` |

Playwright's license and notices are retained inside its collected driver
resources. The PyInstaller bootloader is licensed under GPL-2.0 with its
distribution exception. Python retains the PSF license.

The unused `upstream/` files retain Google's pinned Computer Use Preview
source commit `77c9797e943aad63bbc963b7fd092a9e51c07863` and original Apache-2.0
headers; `LICENSE` preserves that source's license. These files are retained
for provenance and are never imported or packaged as executable agent code.
