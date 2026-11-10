"""Contact sheet for make_broadleaf.py renders (system python + PIL): both trees at each LOD + textures."""
from PIL import Image, ImageDraw, ImageFont
import numpy as np
import os
W = os.environ.get('VALLEY_WORK', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'build', 'blender')).replace(os.sep, '/') + '/broadleaf/'
R = W + 'renders/'
T = W + 'out/textures/'
try:
    FONT = ImageFont.truetype('arial.ttf', 18)
except Exception:
    FONT = ImageFont.load_default()

def fit(im, h, nearest=False):
    return im.resize((max(1, round(im.width * h / im.height)), h), Image.NEAREST if nearest else Image.LANCZOS)

def row(items, h, gap=6):
    ims = [(lab, fit(im, h, nearest)) for lab, im, nearest in items]
    wsum = sum(i.width for _, i in ims) + gap * (len(ims) - 1)
    S = Image.new('RGB', (wsum, h + 26), (24, 24, 24))
    d = ImageDraw.Draw(S); x = 0
    for lab, im in ims:
        S.paste(im, (x, 26)); d.text((x + 4, 3), lab, fill=(230, 230, 230), font=FONT); x += im.width + gap
    return S

def stack(rows, gap=8):
    w = max(r.width for r in rows); h = sum(r.height for r in rows) + gap * (len(rows) - 1)
    S = Image.new('RGB', (w, h), (24, 24, 24)); y = 0
    for r in rows:
        S.paste(r, (0, y)); y += r.height + gap
    return S

ld = lambda n: Image.open(R + n).convert('RGB')
rows = []
for tid, desc in (('oak_a', 'oak_a 14 m'), ('oak_b', 'oak_b 18 m')):
    rows.append(row([(f'{desc} LOD0 45 m', ld(f'{tid}_lod0.png'), False),
                     ('LOD1 45 m', ld(f'{tid}_lod1.png'), False),
                     ('LOD2 45 m', ld(f'{tid}_lod2.png'), False),
                     ('LOD0 back light', ld(f'{tid}_back.png'), False),
                     ('LOD0 11 m looking up', ld(f'{tid}_near.png'), False),
                     ('150 m LOD0 (x2)', ld(f'{tid}_far0.png'), True),
                     ('150 m LOD2 (x2)', ld(f'{tid}_far2.png'), True)], 320))
c = np.asarray(Image.open(T + 'broadleaf_leaves_c.webp')).astype(np.float32) / 255
bg = np.ones_like(c[..., :3]) * np.array([0.72, 0.78, 0.84])
a = (c[..., 3:] > 0.5).astype(np.float32)
comp = Image.fromarray((255 * (c[..., :3] * a + bg * (1 - a))).astype(np.uint8))
rows.append(row([('leaves_c (alpha>0.5) over sky', comp, False),
                 ('leaves_n', Image.open(T + 'broadleaf_leaves_n.webp').convert('RGB'), False),
                 ('leaves_m', Image.open(T + 'broadleaf_leaves_m.webp').convert('RGB'), False),
                 ('bark_c (oak, cottonwood, smooth, branch)', Image.open(T + 'broadleaf_bark_c.webp').convert('RGB'), False),
                 ('bark_n', Image.open(T + 'broadleaf_bark_n.webp').convert('RGB'), False)], 320))
S = stack(rows)
S.save(W + 'sheet.png'); print('sheet', S.size)
