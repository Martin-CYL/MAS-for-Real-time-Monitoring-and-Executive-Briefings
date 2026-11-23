"""Small HTML tree retaining text order, ancestors and source line numbers."""
from dataclasses import dataclass, field
from html.parser import HTMLParser
import re

SKIP = {'style', 'script', 'title', 'template', 'noscript'}
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}


@dataclass
class Node:
    tag: str
    attrs: dict
    line: int = 0
    parent: object = None
    children: list = field(default_factory=list)

    @property
    def classes(self):
        return set((self.attrs.get('class') or '').split())

    def text(self):
        if self.tag in SKIP or 'hidden' in self.attrs or self.attrs.get('aria-hidden') == 'true':
            return ''
        return ''.join(c if isinstance(c, str) else c.text() for c in self.children)

    def ancestors(self):
        p = self
        while p:
            yield p
            p = p.parent


class Document(HTMLParser):
    def __init__(self, raw):
        super().__init__(convert_charrefs=True)
        self.root = Node('document', {})
        self.stack = [self.root]
        self.nodes = []
        self.feed(raw)
        self.close()

    def handle_starttag(self, tag, attrs):
        n = Node(tag, dict(attrs), self.getpos()[0], self.stack[-1])
        self.stack[-1].children.append(n)
        self.nodes.append(n)
        if tag not in VOID:
            self.stack.append(n)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for i in range(len(self.stack)-1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)

    def selected(self, cls):
        return [n for n in self.nodes if cls in n.classes]

    def visible_segments(self):
        blocks = {'p','div','section','article','aside','td','th','h1','h2','h3','footer','header','br','li'}
        def walk(n):
            if n.tag in SKIP or 'hidden' in n.attrs or n.attrs.get('aria-hidden') == 'true':
                return
            if n.tag in blocks:
                yield ('\n', n)
            for c in n.children:
                if isinstance(c, str):
                    yield (c, n)
                else:
                    yield from walk(c)
            if n.tag in blocks:
                yield ('\n', n)
        return list(walk(self.root))


def normalized(text):
    return re.sub(r'\s+', ' ', text).strip()
