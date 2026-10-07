import math, struct
from pathlib import Path
import cairo

def theme(home, identity):
    color = tuple(int(identity['color'][i:i+2], 16)/255 for i in (1, 3, 5))
    portrait = cairo.ImageSurface.create_from_png(f"/opt/blots/avatars/{identity['avatar']}.png") if identity['avatar'] else None
    directory = home / '.icons' / 'Blots'
    (directory / 'cursors').mkdir(parents=True, exist_ok=True)
    (directory / 'index.theme').write_text('[Icon Theme]\nName=Blots\nInherits=Adwaita\n')
    cache = {}
    for alias in Path('/usr/share/icons/Adwaita/cursors').iterdir():
        source = alias.resolve()
        if source not in cache:
            raw = source.read_bytes()
            _, header, _, count = struct.unpack_from('<4I', raw)
            entries = [struct.unpack_from('<3I', raw, header+i*12) for i in range(count)]
            size = min((size for kind,size,_ in entries if kind == 0xfffd0002), key=lambda size: abs(size-32))
            chunks = []
            for kind, nominal, offset in entries:
                if kind != 0xfffd0002 or nominal != size:
                    continue
                length, _, _, _, width, height, xhot, yhot, delay = struct.unpack_from('<9I', raw, offset)
                pixels = bytearray(raw[offset+length:offset+length+width*height*4])
                base = cairo.ImageSurface.create_for_data(pixels, cairo.FORMAT_ARGB32, width, height)
                hx, hy = xhot+16, yhot+32
                w, h = max(width+16, hx+42), max(height+32, hy+18)
                surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, w, h)
                pen = cairo.Context(surface)
                glow = cairo.RadialGradient(hx, hy, 0, hx, hy, 17)
                glow.add_color_stop_rgba(0, *color, .55)
                glow.add_color_stop_rgba(1, *color, 0)
                pen.set_source(glow); pen.paint()
                pen.set_source_surface(base, 16, 32); pen.paint()
                left, top = hx+12, hy-30
                if portrait:
                    pen.save(); pen.translate(left, top); pen.scale(28/portrait.get_width(), 28/portrait.get_height())
                    pen.set_source_surface(portrait); pen.get_source().set_filter(cairo.FILTER_BEST); pen.paint(); pen.restore()
                else:
                    pen.set_source_rgb(*color); pen.arc(left+14, top+14, 14, 0, math.tau); pen.fill()
                    pen.set_source_rgb(1, 1, 1); pen.set_font_size(17)
                    text = identity['name'][0].upper(); extents = pen.text_extents(text)
                    pen.move_to(left+14-extents.width/2-extents.x_bearing, top+14-extents.height/2-extents.y_bearing); pen.show_text(text)
                surface.flush()
                chunk = struct.pack('<9I', 36, kind, 64, 1, w, h, hx, hy, delay) + bytes(surface.get_data())
                chunks.append(chunk)
            offset = 16+12*len(chunks)
            table = bytearray()
            for chunk in chunks:
                table.extend(struct.pack('<3I', 0xfffd0002, 64, offset)); offset += len(chunk)
            cache[source] = struct.pack('<4I', 0x72756358, 16, 0x10000, len(chunks)) + table + b''.join(chunks)
        (directory / 'cursors' / alias.name).write_bytes(cache[source])
