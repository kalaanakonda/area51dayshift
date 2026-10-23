import { Engine } from './core/Engine.js';
import { Input } from './core/Input.js';
import { Director } from './core/Director.js';
import { FirstPersonRig } from './camera/FirstPersonRig.js';
import { AudioDirector } from './audio/AudioDirector.js';
import { AssetLibrary } from './assets/AssetLibrary.js';
import { UI } from './ui/UI.js';
import { Interactions } from './interaction/Interactions.js';
import { HandRig } from './player/HandRig.js';
import { StarbaseSet } from './procedural/starbase.js';
import { Scene1Call } from './scenes/Scene1Call.js';
import { Scene2Bridge } from './scenes/Scene2Bridge.js';
import { Scene3Transit } from './scenes/Scene3Transit.js';
import { Scene4Landing } from './scenes/Scene4Landing.js';
import { Scene5FirstStep } from './scenes/Scene5FirstStep.js';
import { CHAPTERS, FLAGS, isSmallTouchDevice, QUALITY_TIERS } from './config.js';
import { frame } from './scenes/SceneBase.js';

/**
 * FIRST STEP — bootstrap.
 *
 * Boot order mirrors a film set: build every location while the slate is up
 * (loading screen), compile every shader, then roll on the player's click
 * (which also unlocks Web Audio).
 */
async function boot() {
  const ui = new UI(document.getElementById('ui'));
  const canvas = document.getElementById('stage');

  if (isSmallTouchDevice()) await ui.deviceNotice();

  let engine;
  try {
    engine = new Engine(canvas);
    if (!engine.renderer.capabilities.isWebGL2) throw new Error('WebGL2 unavailable');
  } catch (err) {
    console.error(err);
    ui.fatal('This film needs WebGL 2 and hardware acceleration. Try a current desktop browser (Chrome, Edge, Firefox or Safari 17+).');
    return;
  }

  const input = new Input();
  const assets = new AssetLibrary(engine.renderer);
  const audio = new AudioDirector(assets);
  const rig = new FirstPersonRig(engine.camera, input);
  const ctx = { engine, input, assets, audio, ui, rig, post: engine.post, music: {} };
  ctx.interactions = new Interactions(ctx);
  ctx.hands = new HandRig(ctx);

  // ---------------------------------------------------------------- load
  const steps = { assets: 0.12, starbase: 0.3, scenes: 0.43, warm: 0.15 };
  let base = 0;
  const report = (w) => (f, label) => ui.setProgress(base + w * f, label);

  ui.setProgress(0.02, 'Reading the manifest');
  await assets.init();
  await assets.loadModels(report(steps.assets));
  base += steps.assets;
  await ctx.hands.build(assets);
  await frame();

  const starbase = new StarbaseSet(ctx);
  await starbase.build(report(steps.starbase));
  base += steps.starbase;
  await frame();

  const scenes = [
    new Scene1Call(ctx, starbase),
    new Scene2Bridge(ctx, starbase),
    new Scene3Transit(ctx, starbase),
    new Scene4Landing(ctx),
    new Scene5FirstStep(ctx),
  ];
  const director = new Director(ctx, scenes);
  ctx.director = director;
  await director.build(report(steps.scenes));
  base += steps.scenes;

  ui.setProgress(base, 'Compiling shaders');
  await director.warmup((f) => ui.setProgress(base + steps.warm * f, 'Compiling shaders'));
  ui.setProgress(1, 'Ready');

  // Main loop: camera first, then the scene, then interactions, then the hands
  // (so hands always read this frame's camera, props and control positions).
  engine.addUpdater((dt, t) => {
    rig.update(dt);
    director.update(dt, t);
    ctx.interactions.update(dt);
    ctx.hands.update(dt, t);
    ui.setBar(barPixels(engine));
  });

  audio.init();
  if (FLAGS.mute) audio.setMuted(true);
  engine.post.grade.uFade.value = 0;
  engine.start();

  const procedural = assets.report.procedural.length;
  ui.loaderReady(procedural ? `Ready · ${procedural} procedural stand-ins awaiting BlendKit assets` : 'Ready');

  // ---------------------------------------------------------------- run
  let started = false;
  const begin = async () => {
    if (started) return;
    started = true;
    await audio.resume();
    ui.hideLoader();
    director.start();
  };
  ui.on('begin', begin);
  if (FLAGS.auto && FLAGS.debug) setTimeout(begin, 400);

  director.onFinished = () => ui.showCredits();
  ui.on('replay', () => {
    ui.showTitle(false);
    document.body.classList.add('is-playing');
    director.play(0);
  });

  // Pause menu
  let paused = false;
  const setPaused = (p) => {
    if (!started) return;
    paused = p;
    engine.setPaused(p);
    if (p) audio.suspend();
    else audio.resume();
    ui.showPause(p, `Chapter ${CHAPTERS[director.index]?.numeral ?? ''} · quality ${engine.quality.name} · ${procedural} procedural stand-ins`);
  };
  ui.on('resume', () => setPaused(false));
  ui.on('subs', () => ui.toggleSubs());
  ui.on('mute', () => {
    audio.setMuted(!audio.muted);
    ui.toast(audio.muted ? 'Sound off' : 'Sound on');
  });
  ui.on('quality', () => cycleQuality());
  ui.on('chapter', (n) => {
    setPaused(false);
    director.play(n - 1);
  });

  const cycleQuality = () => {
    const order = ['low', 'medium', 'high'];
    const next = order[(order.indexOf(engine.quality.name) + 1) % order.length];
    engine.setQuality(next);
    ui.toast(`Quality · ${QUALITY_TIERS[next].name}`);
  };

  input.on('key', (e) => {
    if (e.code === 'Escape') setPaused(!paused);
    else if (e.code === 'KeyM') {
      audio.setMuted(!audio.muted);
      ui.toast(audio.muted ? 'Sound off' : 'Sound on');
    } else if (e.code === 'KeyC') ui.toggleSubs();
    else if (e.code === 'KeyQ') cycleQuality();
    else if (FLAGS.debug && e.code === 'BracketRight') director.play(Math.min(4, director.index + 1));
    else if (FLAGS.debug && e.code === 'BracketLeft') director.play(Math.max(0, director.index - 1));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && started && !paused) setPaused(true);
  });

  if (FLAGS.debug) mountDebug(ctx, director, ui);
  window.__firstStep = ctx; // handy in the console: __firstStep.director.play(3)
}

/** Height in CSS px of one letterbox bar (subtitles sit inside it). */
function barPixels(engine) {
  const u = engine.post.grade;
  const aspect = window.innerWidth / window.innerHeight;
  const frac = Math.max(0, (1 - aspect / u.uTargetAspect.value) * 0.5) * u.uLetterbox.value;
  return frac * window.innerHeight;
}

function mountDebug(ctx, director, ui) {
  const el = ui.debugPanel();
  const r = ctx.engine.renderer;
  const render = () => {
    const sc = director.current;
    el.innerHTML = '';
    const pre = document.createElement('div');
    pre.textContent =
      `${sc ? sc.label : '—'}  t=${director.time.toFixed(1)} / ${director.duration.toFixed(1)}s\n` +
      `fps ${ctx.engine.fps.toFixed(0)}  calls ${r.info.render.calls}  tris ${(r.info.render.triangles / 1000).toFixed(0)}k\n` +
      `quality ${ctx.engine.quality.name}  dpr ${ctx.engine.pixelRatio.toFixed(2)}`;
    el.appendChild(pre);
    CHAPTERS.forEach((c) => {
      const b = document.createElement('button');
      b.textContent = c.numeral;
      b.onclick = () => director.play(c.id - 1);
      el.appendChild(b);
    });
  };
  setInterval(render, 500);
}

boot();
