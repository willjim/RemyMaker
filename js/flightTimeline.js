export const MIN_TIMELINE_SEGMENT = 0.05;

export function getManualTimelineTimes(durations) {
  const times = [0];
  for (const duration of durations) {
    times.push(times.at(-1) + (Number.isFinite(duration) ? Math.max(MIN_TIMELINE_SEGMENT, duration) : 2));
  }
  return times;
}

export function normalizeManualTimelineTimes(times, duration = times.at(-1)) {
  if (times.length < 2) return times.length === 1 ? [0] : [];
  const last = times.length - 1;
  const total = Math.max(last * MIN_TIMELINE_SEGMENT, Number.isFinite(duration) ? duration : 0);
  const result = [0];
  for (let index = 1; index < last; index++) {
    const min = result[index - 1] + MIN_TIMELINE_SEGMENT;
    const max = total - (last - index) * MIN_TIMELINE_SEGMENT;
    const time = Number.isFinite(times[index]) ? times[index] : min;
    result.push(Math.min(Math.max(time, min), max));
  }
  result.push(total);
  return result;
}

export function moveTimelineKeyframe(times, index, time) {
  if (!Number.isInteger(index) || index <= 0 || index >= times.length - 1 || !Number.isFinite(time)) return times;
  const result = times.slice();
  result[index] = Math.min(
    times[index + 1] - MIN_TIMELINE_SEGMENT,
    Math.max(times[index - 1] + MIN_TIMELINE_SEGMENT, time)
  );
  return result;
}

export function scaleTimelineTimes(times, duration) {
  const previous = times.at(-1);
  if (!Number.isFinite(duration) || duration <= 0 || !previous || times.length < 2) return times;
  return normalizeManualTimelineTimes(times.map(time => time / previous * duration), duration);
}

const labels = {
  zh: {
    title: '运镜时间轴', play: '播放', pause: '暂停', resume: '继续播放', stop: '停止',
    export: '导出视频', duration: '总时长（秒）', timing: '关键帧节奏', auto: '自动', manual: '手动',
    playhead: '播放位置', camera: '镜头', particle: '点云', renderer: '实景切换', keyframe: '视角',
    prev: '上一帧', next: '下一帧', add: '添加关键帧', update: '更新视角', remove: '删除',
    time: '时间（秒）', start: '开始（秒）', length: '时长（秒）', direction: '方向',
    none: '无特效', editParticle: '编辑点云区间', gather: '聚合', scatter: '消散',
    'gather-scatter': '聚合后消散', addEvent: '添加切换', initial: '初始模式', target: '切换到',
    spark: '3D 实景', particles: '粒子', style: '过渡', fade: '渐变', fly: '逐区聚散',
    all: '四周', left: '左', right: '右', top: '上', bottom: '下',
    switchToSpark: '切换实景', switchToParticles: '切换粒子',
    overflow: '超出运镜时长的特效区间将在导出时截断。',
    empty: '添加两个视角开始运镜。', preset: '内置运镜',
  },
  en: {
    title: 'Camera timeline', play: 'Play', pause: 'Pause', resume: 'Resume', stop: 'Stop',
    export: 'Export video', duration: 'Total (s)', timing: 'Keyframe timing', auto: 'Auto', manual: 'Manual',
    playhead: 'Playback position', camera: 'Camera', particle: 'Particles', renderer: 'Mode switches', keyframe: 'View',
    prev: 'Previous', next: 'Next', add: 'Add keyframe', update: 'Update view', remove: 'Delete',
    time: 'Time (s)', start: 'Start (s)', length: 'Length (s)', direction: 'Direction',
    none: 'No effect', editParticle: 'Edit particle interval', gather: 'Gather', scatter: 'Scatter',
    'gather-scatter': 'Gather then scatter', addEvent: 'Add switch', initial: 'Initial mode', target: 'Switch to',
    spark: '3D reality', particles: 'Particles', style: 'Transition', fade: 'Fade', fly: 'Progressive assembly',
    all: 'All sides', left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom',
    switchToSpark: 'Switch to reality', switchToParticles: 'Switch to particles',
    overflow: 'Effects beyond the camera path will be cut off in the export.',
    empty: 'Add two views to create a camera path.', preset: 'Camera preset',
  },
};

function textSeconds(seconds, lang) {
  return `${Number(seconds.toFixed(2))}${lang === 'en' ? ' s' : ' 秒'}`;
}

function niceTickStep(duration, targetCount) {
  const step = duration / targetCount;
  const scale = 10 ** Math.floor(Math.log10(step));
  return ([1, 2, 5, 10].find(value => value * scale >= step) || 10) * scale;
}

const clampTime = (time, total) => Math.min(Math.max(time, 0), total);
const fieldTime = value => Number.isFinite(value) ? String(Number(value.toFixed(3))) : '';

/**
 * View-only timeline editor. The application owns all data and revision
 * validation. Pointer drags update the visual marker until committed on release.
 */
export function createFlightTimeline(panel, onAction) {
  let view;
  let words;
  let refs;
  let selection = { type: 'keyframe', index: null };
  let drag = null;
  let suppressClickUntil = 0;

  const send = (type, data) => onAction({ type, ...data });
  const clock = () => performance.now();
  const duration = () => Math.max(0, view.duration || 0);
  const percentage = time => (duration() ? clampTime(time, duration()) / duration() : 0) * 100;
  const markerTitle = (time, caption) => `${caption} · ${textSeconds(time, view.lang)}`;
  const editLocked = () => view.locked || view.playing || view.busy;
  const query = selector => panel.querySelector(selector);

  function setup() {
    const { lang } = view;
    words = labels[lang] || labels.zh;
    const opts = (...keys) => keys.map(key => `<option value="${key}">${words[key]}</option>`).join('');
    const button = (action, caption = action) =>
      `<button type="button" data-flight-action="${action}">${words[caption]}</button>`;
    const number = (key, caption, min = 0) =>
      `<label>${words[caption]}<input type="number" data-flight-field="${key}" min="${min}" step="any" inputmode="decimal"></label>`;
    const select = (key, caption, ...values) =>
      `<label>${words[caption]}<select data-flight-field="${key}">${opts(...values)}</select></label>`;
    const open = refs ? refs.details.open : true;
    panel.innerHTML = `
      <details class="flight-timeline-disclosure"${open ? ' open' : ''}>
        <summary>${words.title}</summary>
        <div class="flight-timeline-controls">
          ${button('transport', 'play')}${button('stop')}
          ${button('switch-renderer', 'switchToSpark')}${button('export')}
          ${number('duration', 'duration', 0.05)}
          ${select('timing-mode', 'timing', 'auto', 'manual')}
          <output class="flight-timeline-readout"></output>
        </div>
        <div class="flight-timeline-scroll">
          <div class="flight-timeline-tracks">
            <div class="flight-track-label" aria-hidden="true"></div>
            <div class="flight-track flight-ruler">
              <div class="flight-ticks" aria-hidden="true"></div>
              <input class="flight-seek" type="range" min="0" step="any" aria-label="${words.playhead}">
            </div>
            <div class="flight-track-label">${words.camera}</div>
            <div class="flight-track flight-keyframe-track" role="group" aria-label="${words.camera}"></div>
            <div class="flight-track-label">${words.particle}</div>
            <div class="flight-track flight-particle-track" role="group" aria-label="${words.particle}"></div>
            <div class="flight-track-label">${words.renderer}</div>
            <div class="flight-track flight-renderer-track" role="group" aria-label="${words.renderer}"></div>
          </div>
        </div>
        <div class="flight-timeline-controls flight-keyframe-controls">
          ${button('previous-keyframe', 'prev')}${button('next-keyframe', 'next')}${button('add-keyframe', 'add')}
          <div class="flight-keyframe-inspector">
            ${number('keyframe-time', 'time')}${button('update-keyframe', 'update')}${button('delete-keyframe', 'remove')}
          </div>
        </div>
        <div class="flight-timeline-controls flight-renderer-controls">
          ${select('initial-renderer', 'initial', 'particles', 'spark')}${button('add-event', 'addEvent')}
        </div>
        <div class="flight-timeline-controls flight-particle-inspector" hidden>
          ${number('particle-start', 'start')}${number('particle-duration', 'length', 0.05)}
          ${select('particle-direction', 'direction', 'gather', 'scatter', 'gather-scatter')}
        </div>
        <div class="flight-timeline-controls flight-event-inspector" hidden>
          ${number('event-time', 'time')}
          ${select('event-renderer', 'target', 'particles', 'spark')}
          ${select('event-type', 'style', 'fade', 'fly')}
          ${select('event-direction', 'direction', 'all', 'left', 'right', 'top', 'bottom')}
          ${number('event-duration', 'length', 0.05)}${button('delete-event', 'remove')}
        </div>
        <div class="flight-timeline-warning" hidden>${words.overflow}</div>
      </details>`;
    refs = {
      details: query('details'), tracks: query('.flight-timeline-tracks'), scroller: query('.flight-timeline-scroll'),
      ticks: query('.flight-ticks'), seek: query('.flight-seek'), readout: query('.flight-timeline-readout'),
      keyframes: query('.flight-keyframe-track'), particle: query('.flight-particle-track'),
      renderer: query('.flight-renderer-track'), warning: query('.flight-timeline-warning'),
      keyControls: query('.flight-keyframe-controls'), keyInspector: query('.flight-keyframe-inspector'),
      particleInspector: query('.flight-particle-inspector'), eventInspector: query('.flight-event-inspector'),
      fields: Object.fromEntries([...panel.querySelectorAll('[data-flight-field]')].map(node => [node.dataset.flightField, node])),
      buttons: Object.fromEntries([...panel.querySelectorAll('[data-flight-action]')].map(node => [node.dataset.flightAction, node])),
    };
    refs.seek.addEventListener('input', () => send('seek', { time: Number(refs.seek.value) }));
  }

  function marker(type, index, time, caption, length = null) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = `flight-marker flight-marker-${type}`;
    node.dataset.marker = type;
    node.dataset.index = String(index);
    node.dataset.time = String(time);
    node.style.setProperty('--start', `${percentage(time)}%`);
    if (length !== null) node.style.setProperty('--length', `${percentage(time + length) - percentage(time)}%`);
    node.classList.toggle('at-start', time <= 0);
    node.classList.toggle('at-end', time >= duration());
    node.classList.toggle('overrun', Number.isFinite(length) && time + length > duration() + 1e-6);
    node.title = markerTitle(time, caption);
    node.setAttribute('aria-label', node.title);
    node.textContent = type === 'keyframe' ? index + 1 : caption;
    return node;
  }

  function renderTracks() {
    const total = duration();
    const density = Math.max(view.preset ? 0 : view.keyframes.length, view.events.length);
    refs.tracks.style.setProperty('--track-width', `${Math.min(2400, Math.max(286, density * 40 + 90))}px`);
    refs.ticks.replaceChildren();
    if (total > 0) {
      const step = niceTickStep(total, 6);
      const tickTimes = [0];
      for (let time = step; time < total - step * 0.45; time += step) tickTimes.push(time);
      tickTimes.push(total);
      for (const time of tickTimes) {
        const tick = document.createElement('span');
        tick.textContent = textSeconds(time, view.lang);
        tick.style.left = `${percentage(time)}%`;
        refs.ticks.append(tick);
      }
    }
    refs.keyframes.replaceChildren();
    if (view.preset || !view.keyframes.length) {
      const hint = document.createElement('span');
      hint.className = 'flight-track-hint';
      hint.textContent = view.preset ? words.preset : words.empty;
      refs.keyframes.append(hint);
    } else {
      for (const [index, frame] of view.keyframes.entries()) {
        const node = marker('keyframe', index, frame.time, `${words.keyframe} ${index + 1}`);
        if (index === 0 || index === view.keyframes.length - 1) node.classList.add('fixed-marker');
        refs.keyframes.append(node);
      }
    }
    const particle = view.particle;
    refs.particle.replaceChildren();
    if (particle.enabled) {
      refs.particle.append(marker('particle', 0, particle.start, words[particle.direction] || words.particle, particle.duration));
    } else {
      const hint = document.createElement('span');
      hint.className = 'flight-track-hint';
      hint.textContent = words.none;
      refs.particle.append(hint);
    }
    refs.renderer.replaceChildren(...view.events.map((event, index) =>
      marker('event', index, event.time, words[event.renderer], event.duration)));
    refs.warning.hidden = !(particle.enabled && particle.start + particle.duration > total + 1e-6)
      && !view.events.some(event => event.time + event.duration > total + 1e-6);
  }

  function renderControls() {
    const { fields, buttons } = refs;
    const locked = editLocked();
    const index = view.selectedKeyframe;
    const frame = view.keyframes[index];
    const event = view.events[selection.index];
    refs.keyControls.hidden = view.preset;
    refs.keyInspector.hidden = selection.type !== 'keyframe' || !frame;
    refs.particleInspector.hidden = selection.type !== 'particle' || !view.particle.enabled;
    refs.eventInspector.hidden = selection.type !== 'event' || !event;
    fields['timing-mode'].parentElement.hidden = view.preset;
    buttons.transport.textContent = view.playing ? words.pause : view.paused ? words.resume : words.play;
    buttons.transport.disabled = view.busy || (!view.canPlay && !view.playing);
    buttons.stop.disabled = view.busy || !(view.playing || view.paused || view.time > 0);
    buttons.export.disabled = view.busy || !view.canPlay;
    buttons['previous-keyframe'].disabled = locked || !view.keyframes.length || (frame && index <= 0);
    buttons['next-keyframe'].disabled = locked || !view.keyframes.length || (frame && index >= view.keyframes.length - 1);
    buttons['add-keyframe'].disabled = locked || !view.canAdd;
    buttons['update-keyframe'].disabled = locked || !frame;
    buttons['delete-keyframe'].disabled = locked || !frame;
    buttons['add-event'].disabled = locked || !view.canPlay || view.time >= duration();
    buttons['delete-event'].disabled = locked || !event;
    refs.seek.max = String(duration());
    refs.seek.disabled = view.busy || !view.canPlay;
    for (const field of Object.values(fields)) field.disabled = locked;
    fields.duration.value = fieldTime(duration());
    fields.duration.disabled ||= !view.preset && view.keyframes.length < 2;
    fields['timing-mode'].value = view.timingMode === 'manual' ? 'manual' : 'auto';
    fields['keyframe-time'].value = frame ? fieldTime(frame.time) : '';
    fields['keyframe-time'].disabled ||= index == null || index === 0 || index === view.keyframes.length - 1;
    fields['particle-start'].value = fieldTime(view.particle.start);
    fields['particle-duration'].value = fieldTime(view.particle.duration);
    fields['particle-direction'].value = view.particle.direction;
    fields['initial-renderer'].value = view.initialRenderer;
    if (event) {
      fields['event-time'].value = fieldTime(event.time);
      fields['event-renderer'].value = event.renderer;
      fields['event-type'].value = event.type || 'fade';
      fields['event-direction'].value = event.direction || 'all';
      fields['event-direction'].parentElement.hidden = event.type !== 'fly';
      fields['event-duration'].value = fieldTime(event.duration);
    }
    for (const node of panel.querySelectorAll('[data-marker]')) {
      const { marker: type, index: markerIndex } = node.dataset;
      const selected = selection.type === type
        && (type === 'particle' || Number(markerIndex) === (type === 'keyframe' ? index : selection.index));
      node.setAttribute('aria-pressed', String(selected));
      node.disabled = Boolean(view.busy || view.playing);
    }
  }

  function setTime(seconds, { switchDisabled = view.switchDisabled, currentRenderer = view.currentRenderer } = {}) {
    if (!refs) return;
    const time = clampTime(seconds, duration());
    view.time = time;
    view.switchDisabled = switchDisabled;
    view.currentRenderer = currentRenderer;
    refs.seek.value = String(time);
    refs.tracks.style.setProperty('--playhead', `${percentage(time)}%`);
    refs.seek.setAttribute('aria-valuetext', textSeconds(time, view.lang));
    refs.readout.value = `${textSeconds(time, view.lang)} / ${textSeconds(duration(), view.lang)}`;
    refs.buttons['switch-renderer'].disabled = Boolean(switchDisabled || view.busy || !view.canPlay);
    refs.buttons['switch-renderer'].textContent = currentRenderer === 'spark' ? words.switchToParticles : words.switchToSpark;
    refs.buttons['add-event'].disabled = editLocked() || !view.canPlay || time >= duration();
    refs.buttons.stop.disabled = view.busy || !(view.playing || view.paused || time > 0);
  }

  function update(next) {
    const priorLang = view?.lang;
    const focused = panel.contains(document.activeElement) ? document.activeElement : null;
    const scroll = refs?.scroller.scrollLeft || 0;
    view = { ...next };
    if (!refs || priorLang !== view.lang) setup();
    if (view.playing) refs.details.open = true;
    if (Number.isInteger(view.selectedEvent)) selection = { type: 'event', index: view.selectedEvent };
    if (selection.type === 'event' && !view.events[selection.index]) selection = { type: 'keyframe', index: null };
    if (selection.type === 'particle' && !view.particle.enabled) selection = { type: 'keyframe', index: null };
    renderTracks();
    renderControls();
    setTime(view.time || 0);
    refs.scroller.scrollLeft = scroll;
    if (focused?.dataset.marker && !focused.isConnected) {
      panel.querySelector(`[data-marker="${focused.dataset.marker}"][data-index="${focused.dataset.index}"]`)?.focus({ preventScroll: true });
    }
  }

  function revealMarker(index) {
    const node = refs.keyframes.querySelector(`[data-index="${index}"]`);
    if (!node) return;
    const markerRect = node.getBoundingClientRect();
    const railRect = refs.scroller.getBoundingClientRect();
    if (markerRect.left < railRect.left) refs.scroller.scrollLeft += markerRect.left - railRect.left - 8;
    if (markerRect.right > railRect.right) refs.scroller.scrollLeft += markerRect.right - railRect.right + 8;
  }

  function selectKeyframe(index) {
    selection = { type: 'keyframe', index };
    send('select-keyframe', { index });
    revealMarker(index);
  }

  function applyMarkerClick(node) {
    const index = Number(node.dataset.index);
    const type = node.dataset.marker;
    if (type === 'keyframe') {
      selectKeyframe(index);
    } else {
      selection = { type, index };
      renderControls();
    }
  }

  panel.addEventListener('click', event => {
    if (!view) return;
    if (view.playing && event.target.closest('summary') === refs.details.querySelector('summary')) {
      event.preventDefault();
      return;
    }
    const node = event.target.closest('button');
    if (!node || node.disabled) return;
    if (node.dataset.marker) {
      if (clock() >= suppressClickUntil) applyMarkerClick(node);
      return;
    }
    const action = node.dataset.flightAction;
    if (!action) return;
    if (action === 'transport') {
      send(view.playing ? 'pause' : 'play');
      return;
    }
    if (action === 'previous-keyframe' || action === 'next-keyframe') {
      const backward = action === 'previous-keyframe';
      const index = view.selectedKeyframe == null
        ? (backward ? view.keyframes.length - 1 : 0)
        : view.selectedKeyframe + (backward ? -1 : 1);
      selectKeyframe(index);
      return;
    }
    if (action === 'add-keyframe') {
      selection = { type: 'keyframe', index: null };
      send(action);
      if (view.selectedKeyframe != null) revealMarker(view.selectedKeyframe);
      return;
    }
    if (action === 'add-event') {
      const time = view.time;
      const before = view.events.length;
      send(action);
      if (view.events.length > before) {
        const index = view.events.findIndex(item => Math.abs(item.time - time) < 0.001);
        if (index !== -1) selection = { type: 'event', index };
        renderControls();
      }
      return;
    }
    if (action === 'delete-event') {
      const index = selection.index;
      selection = { type: 'keyframe', index: null };
      send(action, { index });
      return;
    }
    send(action, { index: view.selectedKeyframe });
  });

  function commitField(field) {
    const key = field.dataset.flightField;
    if (!key || editLocked()) return;
    const value = field.type === 'number' ? field.valueAsNumber : field.value;
    if (field.type === 'number' && !Number.isFinite(value)) {
      renderControls();
      return;
    }
    if (key === 'duration') send('set-duration', { duration: value });
    else if (key === 'timing-mode') send('set-timing-mode', { mode: value === 'manual' ? 'manual' : 'automatic' });
    else if (key === 'keyframe-time') send('move-keyframe', { index: view.selectedKeyframe, time: value });
    else if (key === 'initial-renderer') send('set-initial-renderer', { renderer: value });
    else if (key.startsWith('particle-')) send('set-particle', { changes: { [key.slice(9)]: value } });
    else if (key.startsWith('event-')) send('set-event', { index: selection.index, changes: { [key.slice(6)]: value } });
    renderControls();
  }

  panel.addEventListener('change', event => commitField(event.target));
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !event.target.matches('input[type="number"][data-flight-field]')) return;
    event.preventDefault();
    commitField(event.target);
  });

  panel.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || !view || editLocked() || !duration()) return;
    const node = event.target.closest('[data-marker]');
    if (!node || node.disabled || node.classList.contains('fixed-marker')) return;
    const rail = node.parentElement;
    const start = Number(node.dataset.time);
    if (start > duration()) return;
    drag = { node, rail, start, time: start, x: event.clientX, scroll: refs.scroller.scrollLeft, id: event.pointerId, moved: false };
    node.setPointerCapture(event.pointerId);
  });

  panel.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const distance = event.clientX - drag.x;
    if (!drag.moved && Math.abs(distance) < 5) return;
    drag.moved = true;
    const rect = refs.scroller.getBoundingClientRect();
    if (event.clientX < rect.left + 22) refs.scroller.scrollLeft -= 10;
    else if (event.clientX > rect.right - 22) refs.scroller.scrollLeft += 10;
    const pixels = distance + refs.scroller.scrollLeft - drag.scroll;
    const dragTime = drag.start + pixels / Math.max(1, drag.rail.clientWidth) * duration();
    const candidate = clampTime(Math.round(dragTime / MIN_TIMELINE_SEGMENT) * MIN_TIMELINE_SEGMENT, duration());
    const index = Number(drag.node.dataset.index);
    if (drag.node.dataset.marker === 'keyframe') {
      const min = view.keyframes[index - 1].time + MIN_TIMELINE_SEGMENT;
      const max = view.keyframes[index + 1].time - MIN_TIMELINE_SEGMENT;
      drag.time = Math.min(max, Math.max(min, candidate));
    } else drag.time = candidate;
    drag.node.style.setProperty('--start', `${percentage(drag.time)}%`);
  });

  function endDrag(event) {
    if (!drag || drag.id !== event.pointerId) return;
    const { node, start, time, moved } = drag;
    drag = null;
    if (!moved) return;
    suppressClickUntil = clock() + 250;
    node.style.setProperty('--start', `${percentage(start)}%`);
    if (event.type !== 'pointerup' || editLocked()) return;
    const type = node.dataset.marker;
    const index = Number(node.dataset.index);
    selection = { type, index };
    if (type === 'keyframe') send('move-keyframe', { index, time });
    else if (type === 'particle') send('set-particle', { changes: { start: time } });
    else send('set-event', { index, changes: { time } });
    renderControls();
  }

  panel.addEventListener('pointerup', endDrag);
  panel.addEventListener('pointercancel', endDrag);
  panel.addEventListener('lostpointercapture', endDrag);
  panel.closest('.camera-path-panel')?.classList.add('flight-timeline-ready');
  panel.hidden = false;
  return { update, setTime };
}
