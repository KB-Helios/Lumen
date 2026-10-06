"""Fresh Edge DOM adapter. References retain their original frame and node."""
from __future__ import annotations

import base64
import struct
import time
import uuid

from worker import Refusal, validate_initial_url

TIMEOUT = 2000
SELECTOR = 'button,a[href],input,select,textarea,[role],[tabindex],[contenteditable="true"],h1,h2,h3,h4,h5,h6,output'
ELEMENT_STATE = r'''e => {
  const r=e.getBoundingClientRect();
  if (!r.width || !r.height || !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})
      || e.closest('[aria-hidden="true"],[inert]')) return null;
  const type=(e.type||'').toLowerCase(), tag=e.tagName.toLowerCase();
  const protectedValue=type==='password' || e.getAttribute('aria-secret')==='true';
  let role=e.getAttribute('role');
  if (!role) role=({button:'button',a:'link',select:'combobox',textarea:'textbox',output:'status'}[tag]
    || (/^h[1-6]$/.test(tag)?'heading':tag==='input'?
      ({checkbox:'checkbox',radio:'radio',button:'button',submit:'button',range:'slider',number:'spinbutton'}[type]||'textbox'):
      e.isContentEditable?'textbox':'generic'));
  let name=e.getAttribute('aria-label');
  const labelled=e.getAttribute('aria-labelledby');
  if (labelled) name=labelled.split(/\s+/).map(id=>e.ownerDocument.getElementById(id)?.textContent||'').join(' ');
  if (!name && e.labels?.length) name=[...e.labels].map(l=>[...l.childNodes]
    .filter(n=>n.nodeType===3 || !n.contains(e)).map(n=>n.textContent).join(' ')).join(' ');
  if (!name) name=e.getAttribute('alt') || e.getAttribute('title') ||
    (['button','link','heading','status','option'].includes(role)?e.innerText:'') || '';
  const actions=[];
  if (['button','link','checkbox','radio','menuitem'].includes(role)) actions.push('invoke');
  if (['textbox','spinbutton','slider'].includes(role) && !protectedValue && !e.readOnly) actions.push('setValue');
  if (tag==='select') actions.push('select');
  if (e.scrollHeight>e.clientHeight || e.scrollWidth>e.clientWidth) actions.push('scroll');
  const item={role,name:name.trim().slice(0,1000),enabled:!e.disabled && e.getAttribute('aria-disabled')!=='true',actions};
  if (!protectedValue && ('value' in e || e.isContentEditable)) item.value=String(e.value??e.textContent??'').slice(0,4000);
  if (e.id) item.automationId=e.id.slice(0,256);
  return item;
}'''


class BrowserSession:
    def __init__(self, target):
        from playwright.sync_api import sync_playwright
        self.playwright = self.browser = self.context = self.page = None
        self.refs = {}
        self.last_readback = None
        self.last_expected = self.last_descriptor = None
        self.playwright = sync_playwright().start()
        try:
            self.browser = self.playwright.chromium.launch(channel='msedge',
                headless=target['headless'], timeout=5000)
            self.context = self.browser.new_context(viewport={'width': 1440, 'height': 900},
                accept_downloads=False, service_workers='block')
            self.context.set_default_timeout(TIMEOUT)
            self.context.set_default_navigation_timeout(TIMEOUT)
            self.context.route('**/*', self._route)
            self.page = self.context.new_page()
            self.context.on('page', lambda popup: popup.close())
            self.page.on('dialog', lambda dialog: dialog.dismiss())
            self.page.goto(validate_initial_url(target['initialUrl']), wait_until='load')
            self._validate_frames()
        except Exception:
            self.close()
            raise Refusal('targetUnavailable') from None

    @staticmethod
    def _route(route):
        try:
            validate_initial_url(route.request.url)
        except ValueError:
            route.abort('blockedbyclient')
        else:
            route.continue_()

    def _validate_frames(self):
        if self.page.is_closed():
            raise Refusal('targetUnavailable')
        validate_initial_url(self.page.url)
        for frame in self.page.frames:
            if frame.url not in {'', 'about:blank', 'about:srcdoc'}:
                validate_initial_url(frame.url)

    def close(self):
        self.refs.clear()
        try:
            if self.context:
                self.context.close()
            if self.browser:
                self.browser.close()
        finally:
            if self.playwright:
                self.playwright.stop()

    def observe(self, screenshot=False):
        self._validate_frames()
        for handle in self.refs.values():
            try:
                handle.dispose()
            except Exception:
                pass
        self.refs.clear()
        snapshot = uuid.uuid4().hex
        observation = {'snapshotId': snapshot, 'url': self.page.url,
            'title': self.page.title()[:1000], 'elements': [], 'width': 1440, 'height': 900}
        deadline = time.monotonic() + 3
        degraded = False
        for frame in self.page.frames:
            try:
                handles = frame.query_selector_all(SELECTOR)
                for index, handle in enumerate(handles):
                    if len(observation['elements']) >= 300 or time.monotonic() > deadline:
                        degraded = True
                        for remaining in handles[index:]:
                            remaining.dispose()
                        break
                    state = handle.evaluate(ELEMENT_STATE)
                    if state is None:
                        handle.dispose()
                        continue
                    state['ref'] = snapshot + ':' + uuid.uuid4().hex
                    bounds = handle.bounding_box()
                    if bounds:
                        state['bounds'] = bounds
                    self.refs[state['ref']] = handle
                    observation['elements'].append(state)
            except Exception:
                degraded = True
        if degraded:
            observation['degraded'] = True
        if screenshot:
            image = self.page.screenshot(type='png', timeout=TIMEOUT)
            width, height = struct.unpack('>II', image[16:24])
            observation.update(width=width, height=height,
                screenshot={'mimeType': 'image/png', 'data': base64.b64encode(image).decode('ascii')})
        return observation

    def act(self, action, before):
        self._validate_frames()
        self.last_readback = None
        self.last_expected = self.last_descriptor = None
        kind = action['kind']
        result = {'effect': 'unverifiable', 'route': 'playwright', 'verified': False}
        handle = self.refs.get(action.get('element'))
        if action.get('element') and handle is None:
            raise Refusal('staleSnapshot')
        if kind == 'type':
            focused = self._focused_snapshot_element()
            if focused is None or (handle is not None and handle is not focused):
                return {**result, 'effect': 'refused', 'detail': 'staleSnapshot'}
            handle = focused
        if handle is not None:
            state = handle.evaluate(ELEMENT_STATE)
            if state is None or not state['enabled']:
                raise Refusal('targetUnavailable')
            if kind in {'invoke', 'setValue', 'select', 'scroll'} and kind not in state['actions']:
                raise Refusal('invalidAction')
            self.last_descriptor = (state['role'], state['name'], state.get('automationId'))
        try:
            if kind == 'setValue':
                self.last_expected = action['text']
                handle.fill(action['text'], timeout=TIMEOUT)
                self.last_readback = handle.evaluate('(e)=>String(e.value??e.textContent??"")')
            elif kind == 'select':
                options = handle.evaluate('(e)=>[...e.options].slice(0,301).map(o=>({value:o.value,label:o.label,disabled:o.disabled}))')
                matches = [o for o in options if o['value'] == action['text'] or o['label'] == action['text']]
                if len(options) > 300 or len(matches) != 1 or matches[0]['disabled']:
                    raise Refusal('invalidAction')
                self.last_expected = matches[0]['value']
                handle.select_option(value=self.last_expected, timeout=TIMEOUT)
                self.last_readback = handle.evaluate('(e)=>String(e.value)')
            elif kind == 'invoke':
                handle.click(timeout=TIMEOUT)
            elif kind == 'navigate':
                self.page.goto(action['url'], wait_until='domcontentloaded', timeout=TIMEOUT)
                self.last_readback = self.page.url
            elif kind == 'keypress':
                keys = [' ' if key == 'Space' else key for key in action['keys']]
                if handle is not None:
                    handle.press('+'.join(keys), timeout=TIMEOUT)
                else:
                    self.page.keyboard.press('+'.join(keys))
            elif kind == 'type':
                if 'setValue' not in state['actions']:
                    return {**result, 'effect': 'refused', 'detail': 'backgroundUnavailable'}
                # JavaScript slicing retains the browser's UTF-16 selection offsets.
                # Contenteditable ranges need separate verification and stay uncertain.
                self.last_expected = handle.evaluate('''(e,text)=>
                    typeof e.selectionStart==='number' && typeof e.selectionEnd==='number'
                    ? e.value.slice(0,e.selectionStart)+text+e.value.slice(e.selectionEnd)
                    : null''', action['text'])
                self.page.keyboard.insert_text(action['text'])
                self.last_readback = (self.last_expected,
                    handle.evaluate('(e)=>String(e.value??e.textContent??"")'))
            elif kind == 'scroll':
                vector = {'up': (0, -1), 'down': (0, 1), 'left': (-1, 0), 'right': (1, 0)}[action['direction']]
                if handle is not None:
                    handle.evaluate('(e,d)=>e.scrollBy(d[0],d[1])', [n * action['amount'] for n in vector])
                else:
                    if 'x' in action:
                        self.page.mouse.move(action['x'], action['y'])
                    self.page.mouse.wheel(*[n * action['amount'] for n in vector])
            elif kind in {'click', 'doubleClick', 'rightClick'}:
                self.page.mouse.click(action['x'], action['y'],
                    button='right' if kind == 'rightClick' else 'left',
                    click_count=2 if kind == 'doubleClick' else 1)
            elif kind == 'move':
                self.page.mouse.move(action['x'], action['y'])
            elif kind == 'drag':
                self.page.mouse.move(action['x'], action['y'])
                self.page.mouse.down()
                try:
                    self.page.mouse.move(action['endX'], action['endY'], steps=8)
                finally:
                    self.page.mouse.up()
            elif kind == 'wait':
                self.page.wait_for_timeout(action['amount'])
            else:
                raise Refusal('invalidAction')
        except Refusal:
            raise
        except Exception:
            result.update(effect='partial', detail='observationUnavailable')
        return result

    def _focused_snapshot_element(self):
        """Resolve browser focus only to a node retained by the current snapshot."""
        frames = {}
        for handle in self.refs.values():
            frame = handle.owner_frame()
            if frame is not None:
                frames.setdefault(frame, []).append(handle)
        matches = []
        for frame, handles in frames.items():
            active = frame.evaluate_handle('()=>document.hasFocus()?document.activeElement:null')
            try:
                indices = frame.evaluate('''a=>a.nodes.map((e,i)=>e===a.active?i:-1)
                    .filter(i=>i>=0)''', {'active': active, 'nodes': handles})
                matches.extend(handles[index] for index in indices)
            finally:
                active.dispose()
        return matches[0] if len(matches) == 1 else None

    def verify(self, action, before, after, result):
        kind = action['kind']
        confirmed = False
        if result['effect'] == 'partial' or after.get('degraded'):
            return
        candidates = [e for e in after['elements']
            if (e['role'], e['name'], e.get('automationId')) == self.last_descriptor]
        observed_value = candidates[0].get('value') if len(candidates) == 1 else None
        if kind in {'setValue', 'select'}:
            confirmed = self.last_readback == self.last_expected == observed_value
        elif kind == 'navigate':
            confirmed = self.last_readback == action['url'] and after.get('url') == action['url']
        elif kind == 'type' and self.last_readback:
            confirmed = self.last_readback[0] == self.last_readback[1] == observed_value
        if confirmed:
            result.update(effect='confirmed', verified=True)
        elif kind == 'invoke':
            def content(observation):
                return [(e['role'], e['name'], e.get('value')) for e in observation['elements']]
            result['effect'] = 'suspectedNoop' if content(before) == content(after) else 'unverifiable'
