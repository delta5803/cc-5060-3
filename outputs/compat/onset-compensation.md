# Onset compensation by window and sample rate

Shift applied to line the production backend up with the regenerated reference.
Positive = output onset is later than the reference. The window column is the
analysis frame size; each cell shows samples / ms. "—" means that rate was not
generated for that source.

| scenario / source | st | window | 44100 Hz | 48000 Hz | 96000 Hz |
| --- | --- | --- | --- | --- | --- |
| attack-window-edge · attack-window-edge@44100 | 7 | 1024 | 2 / 0.05 | — | — |
| attack-window-edge · attack-window-edge@44100 | 7 | 2048 | -196 / -4.44 | — | — |
| attack-window-edge · attack-window-edge@44100 | 7 | 4096 | -182 / -4.13 | — | — |
| attack-window-edge · attack-window-edge@44100 | -5 | 1024 | -51 / -1.16 | — | — |
| attack-window-edge · attack-window-edge@44100 | -5 | 2048 | -146 / -3.31 | — | — |
| attack-window-edge · attack-window-edge@44100 | -5 | 4096 | -325 / -7.37 | — | — |
| attack-window-edge · attack-window-edge@48000 | 7 | 1024 | — | -28 / -0.58 | — |
| attack-window-edge · attack-window-edge@48000 | 7 | 2048 | — | -100 / -2.08 | — |
| attack-window-edge · attack-window-edge@48000 | 7 | 4096 | — | -99 / -2.06 | — |
| attack-window-edge · attack-window-edge@48000 | -5 | 1024 | — | -40 / -0.83 | — |
| attack-window-edge · attack-window-edge@48000 | -5 | 2048 | — | -140 / -2.92 | — |
| attack-window-edge · attack-window-edge@48000 | -5 | 4096 | — | -327 / -6.81 | — |
| attack-window-edge · attack-window-edge@96000 | 7 | 1024 | — | — | 50 / 0.52 |
| attack-window-edge · attack-window-edge@96000 | 7 | 2048 | — | — | -57 / -0.59 |
| attack-window-edge · attack-window-edge@96000 | 7 | 4096 | — | — | -200 / -2.08 |
| attack-window-edge · attack-window-edge@96000 | -5 | 1024 | — | — | -104 / -1.08 |
| attack-window-edge · attack-window-edge@96000 | -5 | 2048 | — | — | -80 / -0.83 |
| attack-window-edge · attack-window-edge@96000 | -5 | 4096 | — | — | -278 / -2.90 |
| short-attack · short-attack@44100 | 7 | 1024 | -34 / -0.77 | — | — |
| short-attack · short-attack@44100 | 7 | 2048 | -118 / -2.68 | — | — |
| short-attack · short-attack@44100 | 7 | 4096 | -112 / -2.54 | — | — |
| short-attack · short-attack@44100 | -5 | 1024 | -67 / -1.52 | — | — |
| short-attack · short-attack@44100 | -5 | 2048 | -159 / -3.61 | — | — |
| short-attack · short-attack@44100 | -5 | 4096 | -337 / -7.64 | — | — |
| short-attack · short-attack@48000 | 7 | 1024 | — | -92 / -1.92 | — |
| short-attack · short-attack@48000 | 7 | 2048 | — | -86 / -1.79 | — |
| short-attack · short-attack@48000 | 7 | 4096 | — | -302 / -6.29 | — |
| short-attack · short-attack@48000 | -5 | 1024 | — | -119 / -2.48 | — |
| short-attack · short-attack@48000 | -5 | 2048 | — | -119 / -2.48 | — |
| short-attack · short-attack@48000 | -5 | 4096 | — | -311 / -6.48 | — |
| stable-dual · stable-dual@44100 | 7 | 1024 | -2 / -0.05 | — | — |
| stable-dual · stable-dual@44100 | 7 | 2048 | -214 / -4.85 | — | — |
| stable-dual · stable-dual@44100 | 7 | 4096 | -126 / -2.86 | — | — |
| stable-dual · stable-dual@44100 | -5 | 1024 | -37 / -0.84 | — | — |
| stable-dual · stable-dual@44100 | -5 | 2048 | -41 / -0.93 | — | — |
| stable-dual · stable-dual@44100 | -5 | 4096 | -108 / -2.45 | — | — |
| stable-dual · stable-dual@48000 | 7 | 1024 | — | -27 / -0.56 | — |
| stable-dual · stable-dual@48000 | 7 | 2048 | — | -27 / -0.56 | — |
| stable-dual · stable-dual@48000 | 7 | 4096 | — | -27 / -0.56 | — |
| stable-dual · stable-dual@48000 | -5 | 1024 | — | 67 / 1.40 | — |
| stable-dual · stable-dual@48000 | -5 | 2048 | — | -125 / -2.60 | — |
| stable-dual · stable-dual@48000 | -5 | 4096 | — | -212 / -4.42 | — |

Windows: 1024, 2048, 4096. Generated 2026-11-24T04:02:30.588Z.