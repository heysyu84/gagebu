#!/usr/bin/env python3
"""Build mobile and browser PNG/ICO icons from favicon.svg. No ledger data used."""
from io import BytesIO
from pathlib import Path
import cairosvg
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SVG = (ROOT / 'favicon.svg').read_bytes()

def render(size):
    png = cairosvg.svg2png(bytestring=SVG, output_width=size, output_height=size)
    return Image.open(BytesIO(png)).convert('RGBA')

for size, filename in (
    (16, 'favicon-16x16.png'),
    (32, 'favicon-32x32.png'),
    (180, 'apple-touch-icon.png'),
    (192, 'icon-192.png'),
    (512, 'icon-512.png'),
):
    render(size).quantize(colors=32, method=Image.Quantize.FASTOCTREE).save(ROOT / filename, optimize=True)

maskable = Image.new('RGBA', (512, 512), '#071d42')
maskable.alpha_composite(render(392), (60, 60))
maskable.quantize(colors=32, method=Image.Quantize.FASTOCTREE).save(ROOT / 'icon-maskable-512.png', optimize=True)
render(512).save(ROOT / 'favicon.ico', format='ICO', sizes=[(16, 16), (32, 32), (48, 48)])
print('Built seven icons for desktop, iPhone and Android.')
