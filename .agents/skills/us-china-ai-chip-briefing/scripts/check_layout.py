#!/usr/bin/env python3
"""Optional browser regression check. Renders synthetic template content, not news."""
import argparse
import json
from pathlib import Path
import re
import tempfile


def synthetic_template(raw):
    def fill(m):
        label=m[1]
        if 'URL' in label:
            return 'https://fixture.invalid/source'
        if label=='YYYY-MM-DD': return '2030-01-02'
        if label=='YYYY.MM.DD': return '2030.01.02'
        if label=='YYYY 年 M 月 D 日': return '2030 年 1 月 2 日'
        if label=='DD MON YYYY': return '02 JAN 2030'
        if label in ('M 月 D 日','MM.DD'): return '1 月 1 日' if label=='M 月 D 日' else '01.02'
        if label=='NN': return '01'
        if label=='%': return '70%'
        if 'CLAIM_ID' in label: return 'C001'
        return '合成布局测试内容，用于检查窄屏换行和打印效果'
    return re.sub(r'\{\{(.*?)\}\}',fill,raw)


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--template',default=str(Path(__file__).resolve().parents[1]/'assets/template.html'))
    ap.add_argument('--chromium',default='/usr/bin/chromium')
    ap.add_argument('--output-dir',default='evaluation/layout')
    args=ap.parse_args()
    # This is optional; core validators and tests require only Python standard library.
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print('UNVERIFIED: install Playwright and an approved Chromium to run browser checks')
        return 2
    out=Path(args.output_dir); out.mkdir(parents=True,exist_ok=True)
    results=[]
    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
        html=Path(tmp)/'synthetic_layout.html'
        html.write_text(synthetic_template(Path(args.template).read_text(encoding='utf-8')),encoding='utf-8')
        browser=p.chromium.launch(executable_path=args.chromium,headless=True,args=['--no-sandbox'])
        page=browser.new_page()
        # Only local file content. No external downloads/links are followed.
        page.route(re.compile(r'^https?://'),lambda route: route.abort())
        for width in (360,390,768,1320):
            page.set_viewport_size({'width':width,'height':900})
            page.set_content(html.read_text(encoding='utf-8')); page.wait_for_timeout(100)
            metrics=page.evaluate('''() => ({viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
                tableCards: [...document.querySelectorAll('.mobile-cards tr')].every(n=>getComputedStyle(n).display==='block'),
                dateVisible: [...document.querySelectorAll('.mastmeta strong')].every(n=>getComputedStyle(n).display!=='none'),
                offenders: [...document.querySelectorAll('body *')].filter(n=>{const r=n.getBoundingClientRect(); return r.width>1 && (r.right>innerWidth+1 || r.left<-1) && getComputedStyle(n).position!=='absolute'}).slice(0,12).map(n=>n.tagName+'.'+n.className)})''')
            status='PASS' if metrics['scrollWidth']<=width and metrics['dateVisible'] and (width>720 or metrics['tableCards']) else 'FAIL'
            results.append(dict(status=status,mode='screen',**metrics))
            if width in (360,1320): page.screenshot(path=str(out/f'template_{width}.png'),full_page=True)
        page.emulate_media(media='print')
        print_metrics=page.evaluate("() => ({printButtonHidden: getComputedStyle(document.querySelector('.print')).display==='none', stylesheets: document.querySelectorAll('style').length})")
        page.pdf(path=str(out/'template_print.pdf'),format='A4',print_background=True)
        results.append(dict(status='PASS' if print_metrics['printButtonHidden'] and print_metrics['stylesheets']==1 else 'FAIL',mode='print',**print_metrics))
        browser.close()
    (out/'layout_results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
    for r in results: print(r)
    return 1 if any(r['status']=='FAIL' for r in results) else 0


if __name__=='__main__':
    raise SystemExit(main())
