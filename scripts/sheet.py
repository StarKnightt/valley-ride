# contact sheet: python scripts/sheet.py out.png cols label1=img1 label2=img2 ...
import sys
from PIL import Image, ImageDraw, ImageFont

out, cols, items = sys.argv[1], int(sys.argv[2]), [a.split('=', 1) for a in sys.argv[3:]]
W, H = 640, 360
rows = (len(items) + cols - 1) // cols
sheet = Image.new('RGB', (cols * W, rows * (H + 28)), (16, 14, 12))
d = ImageDraw.Draw(sheet)
try:
    font = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 18)
except OSError:
    font = ImageFont.load_default()
for k, (label, path) in enumerate(items):
    im = Image.open(path).convert('RGB').resize((W, H), Image.LANCZOS)
    x, y = (k % cols) * W, (k // cols) * (H + 28)
    sheet.paste(im, (x, y + 28))
    d.text((x + 8, y + 4), label, fill=(240, 228, 205), font=font)
sheet.save(out)
print('sheet', out, sheet.size)
