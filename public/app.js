(() => {
  'use strict';

  const HALO_RADIUS = 96;
  const HALO_CIRCUMFERENCE = 2 * Math.PI * HALO_RADIUS;
  const URGE_HALO_CIRCUMFERENCE = 2 * Math.PI * 54;
  const MICRO_GATE_SECONDS = 120;
  const URGE_COOLDOWN_SECONDS = 15;

  // --- Application State ---
  const state = {
    activeView: 'focus',
    focusStage: 'gate', // 'gate' | 'micro' | 'sprint' | 'reflection'
    selectedMinutes: 25,
    currentSession: null,
    timerInterval: null,
    timerPaused: false,
    microRemainingSec: MICRO_GATE_SECONDS,
    microTotalSec: MICRO_GATE_SECONDS,
    sprintTotalSec: 25 * 60,
    sprintRemainingSec: 25 * 60,
    sprintElapsedSec: 0,
    sprintTabSwitches: 0,
    lastTabSwitchAt: 0,
    strictMode: false,
    sprintBreaches: 0,
    exitingFullscreenCleanly: false,
    canvasTheme: 'off', // 'off' | 'aurora' | 'rain' | 'orbit' | 'ribbon'
    audioMode: 'off', // 'off' | 'brown' | 'pink' | 'rain' | 'cafe' | 'hall' | 'gamma' | 'drone'
    lastActiveAudioMode: 'rain',
    audioVolume: 0.12,
    audioVolumePct: 35,
    activeTaskId: null,
    tasks: [],
    taskTagFilter: 'all',

    // FocusTube state
    videoId: '',
    videoTitle: '',
    videoAuthor: '',
    studyClockSec: 0,
    studyClockRunning: false,
    studyClockInterval: null,
    lockedTimestampSec: null,
    notesForVideo: [],
    studyQueue: [],

    // Urge Shield state
    urgeRemainingSec: URGE_COOLDOWN_SECONDS,
    urgeInterval: null,
    urgeDiversionMode: 'breath', // 'breath' | 'stroop' | 'reset'
    stroopStreak: 0,
    stroopHits: 0,
    stroopAnswer: '',

    // Telemetry cache
    sessions: [],
    allNotes: [],
    telemetry: null,
    sessionFilter: 'all',

    // Command palette
    cmdSelectedIndex: 0
  };

  // --- Web Audio API Procedural Soundscapes & Binaural Engine (Zero External MP3s) ---
  const audioEngine = {
    ctx: null,
    sourceNode: null,
    gainNode: null,
    extraNodes: [],
    tickTimer: null,

    ensureContext() {
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        this.ctx = new AudioCtx();
      }
      if (this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
      return this.ctx;
    },

    createNoiseBuffer(ctx, mode) {
      const sampleRate = ctx.sampleRate;
      const length = sampleRate * 4;
      const buffer = ctx.createBuffer(1, length, sampleRate);
      const output = buffer.getChannelData(0);

      if (mode === 'brown') {
        let lastOut = 0;
        for (let i = 0; i < length; i += 1) {
          const white = Math.random() * 2 - 1;
          lastOut = (lastOut + 0.02 * white) / 1.02;
          output[i] = lastOut * 3.2;
        }
      } else {
        // Paul Kellet pink noise approximation (also base for rain/cafe/hall/gamma air)
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < length; i += 1) {
          const white = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.96900 * b2 + white * 0.1538520;
          b3 = 0.86650 * b3 + white * 0.3104856;
          b4 = 0.55000 * b4 + white * 0.5329522;
          b5 = -0.7616 * b5 - white * 0.0168980;
          let sample = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.08;
          b6 = white * 0.115926;

          // Subtle micro-droplet texture for rain preset
          if (mode === 'rain' && Math.random() < 0.0018) {
            sample += (Math.random() * 2 - 1) * 0.22;
          }
          output[i] = sample;
        }
      }
      return buffer;
    },

    setMode(mode) {
      state.audioMode = mode;
      syncAudioButtons();

      if (mode === 'off') {
        this.stop();
        return;
      }

      const ctx = this.ensureContext();
      if (!ctx) {
        showToast('Web Audio API unavailable in this browser.');
        return;
      }

      this.stop();

      const gain = ctx.createGain();
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, state.audioVolume), now + 0.45);
      gain.connect(ctx.destination);
      this.gainNode = gain;

      if (mode === 'drone') {
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(340, now);
        filter.Q.setValueAtTime(0.7, now);
        filter.connect(gain);
        this.extraNodes.push(filter);

        [
          { freq: 110, type: 'sine', level: 0.48 },
          { freq: 165, type: 'triangle', level: 0.22 },
          { freq: 220, type: 'sine', level: 0.1 }
        ].forEach((voice) => {
          const osc = ctx.createOscillator();
          const vGain = ctx.createGain();
          osc.type = voice.type;
          osc.frequency.setValueAtTime(voice.freq, now);
          vGain.gain.setValueAtTime(voice.level, now);
          osc.connect(vGain);
          vGain.connect(filter);
          osc.start(now);
          this.extraNodes.push(osc, vGain);
        });
        return;
      }

      if (mode === 'gamma') {
        // 40Hz Binaural beat (200Hz L / 240Hz R) + whisper pink air bed
        const airSrc = ctx.createBufferSource();
        airSrc.buffer = this.createNoiseBuffer(ctx, 'pink');
        airSrc.loop = true;
        const airFilter = ctx.createBiquadFilter();
        airFilter.type = 'lowpass';
        airFilter.frequency.setValueAtTime(700, now);
        const airGain = ctx.createGain();
        airGain.gain.setValueAtTime(0.28, now);
        airSrc.connect(airFilter);
        airFilter.connect(airGain);
        airGain.connect(gain);
        airSrc.start(now);
        this.sourceNode = airSrc;
        this.extraNodes.push(airFilter, airGain);

        [
          { freq: 200, pan: -0.85 },
          { freq: 240, pan: 0.85 }
        ].forEach((tone) => {
          const osc = ctx.createOscillator();
          const tGain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(tone.freq, now);
          tGain.gain.setValueAtTime(0.24, now);
          osc.connect(tGain);
          if (typeof ctx.createStereoPanner === 'function') {
            const panner = ctx.createStereoPanner();
            panner.pan.setValueAtTime(tone.pan, now);
            tGain.connect(panner);
            panner.connect(gain);
            this.extraNodes.push(panner);
          } else {
            tGain.connect(gain);
          }
          osc.start(now);
          this.extraNodes.push(osc, tGain);
        });
        return;
      }

      const buffer = this.createNoiseBuffer(ctx, mode);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;

      if (mode === 'rain') {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(980, now);
        bp.Q.setValueAtTime(0.55, now);

        const modGain = ctx.createGain();
        modGain.gain.setValueAtTime(0.85, now);
        const lfo = ctx.createOscillator();
        const lfoDepth = ctx.createGain();
        lfo.frequency.setValueAtTime(0.22, now);
        lfoDepth.gain.setValueAtTime(0.18, now);
        lfo.connect(lfoDepth);
        lfoDepth.connect(modGain.gain);
        lfo.start(now);

        src.connect(bp);
        bp.connect(modGain);
        modGain.connect(gain);
        src.start(now);
        this.sourceNode = src;
        this.extraNodes.push(bp, modGain, lfo, lfoDepth);
        return;
      }

      if (mode === 'cafe') {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(440, now);
        const peak = ctx.createBiquadFilter();
        peak.type = 'peaking';
        peak.frequency.setValueAtTime(760, now);
        peak.gain.setValueAtTime(3.5, now);

        const murmurGain = ctx.createGain();
        murmurGain.gain.setValueAtTime(0.95, now);
        const lfo = ctx.createOscillator();
        const lfoDepth = ctx.createGain();
        lfo.frequency.setValueAtTime(0.14, now);
        lfoDepth.gain.setValueAtTime(0.2, now);
        lfo.connect(lfoDepth);
        lfoDepth.connect(murmurGain.gain);
        lfo.start(now);

        src.connect(lp);
        lp.connect(peak);
        peak.connect(murmurGain);
        murmurGain.connect(gain);
        src.start(now);
        this.sourceNode = src;
        this.extraNodes.push(lp, peak, murmurGain, lfo, lfoDepth);
        return;
      }

      if (mode === 'hall') {
        // Steady HVAC hum (58Hz + 116Hz) + soft filtered room air + subtle 60 BPM clock pulse
        const airLp = ctx.createBiquadFilter();
        airLp.type = 'lowpass';
        airLp.frequency.setValueAtTime(360, now);
        const airGain = ctx.createGain();
        airGain.gain.setValueAtTime(0.55, now);
        src.connect(airLp);
        airLp.connect(airGain);
        airGain.connect(gain);
        src.start(now);
        this.sourceNode = src;
        this.extraNodes.push(airLp, airGain);

        [58, 116].forEach((hz, idx) => {
          const hum = ctx.createOscillator();
          const humGain = ctx.createGain();
          hum.type = 'sine';
          hum.frequency.setValueAtTime(hz, now);
          humGain.gain.setValueAtTime(idx === 0 ? 0.18 : 0.07, now);
          hum.connect(humGain);
          humGain.connect(gain);
          hum.start(now);
          this.extraNodes.push(hum, humGain);
        });

        this.tickTimer = setInterval(() => {
          if (!this.ctx || !this.gainNode || state.audioMode !== 'hall') return;
          const t = this.ctx.currentTime;
          const tickOsc = this.ctx.createOscillator();
          const tickGain = this.ctx.createGain();
          tickOsc.type = 'triangle';
          tickOsc.frequency.setValueAtTime(1600, t);
          tickGain.gain.setValueAtTime(0.0001, t);
          tickGain.gain.exponentialRampToValueAtTime(0.045, t + 0.003);
          tickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
          tickOsc.connect(tickGain);
          tickGain.connect(this.gainNode);
          tickOsc.start(t);
          tickOsc.stop(t + 0.03);
        }, 1000);
        return;
      }

      // Default brown or pink noise
      src.connect(gain);
      src.start(now);
      this.sourceNode = src;
    },

    setVolumePct(pct) {
      const clamped = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
      state.audioVolumePct = clamped;
      state.audioVolume = clamped === 0 ? 0.0001 : (clamped / 100) * 0.35;

      if ($('topbar-audio-volume')) $('topbar-audio-volume').value = String(clamped);
      if ($('noise-volume')) $('noise-volume').value = String(clamped);
      if ($('topbar-audio-pct')) $('topbar-audio-pct').textContent = `${clamped}%`;

      if (this.gainNode && this.ctx) {
        this.gainNode.gain.setTargetAtTime(state.audioVolume, this.ctx.currentTime, 0.05);
      }
    },

    stop() {
      if (this.tickTimer) {
        clearInterval(this.tickTimer);
        this.tickTimer = null;
      }
      if (this.sourceNode) {
        try {
          this.sourceNode.stop();
          this.sourceNode.disconnect();
        } catch (_) {
          // ignore already stopped node
        }
        this.sourceNode = null;
      }
      if (this.extraNodes.length) {
        for (const node of this.extraNodes) {
          try {
            if (typeof node.stop === 'function') node.stop();
            node.disconnect();
          } catch (_) {
            // ignore already stopped node
          }
        }
        this.extraNodes = [];
      }
      if (this.gainNode) {
        try {
          this.gainNode.disconnect();
        } catch (_) {
          // ignore
        }
        this.gainNode = null;
      }
    },

    chime() {
      const ctx = this.ensureContext();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const now = ctx.currentTime;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(528, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.08, now + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.6);
    },

    softBell() {
      const ctx = this.ensureContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      [392, 587.33].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + idx * 0.08);
        gain.gain.setValueAtTime(0.0001, now + idx * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.06, now + idx * 0.08 + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.08 + 0.7);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.08);
        osc.stop(now + idx * 0.08 + 0.75);
      });
    }
  };

  // --- Lightweight Ambient Focus Canvas Engine ---
  const ambientCanvas = {
    rafId: null,
    particles: [],
    t: 0,

    initParticles(w, h) {
      this.particles = Array.from({ length: 42 }, (_, idx) => ({
        x: Math.random() * w,
        y: Math.random() * h,
        speed: 0.45 + Math.random() * 1.1,
        len: 10 + Math.random() * 22,
        angle: (idx / 42) * Math.PI * 2,
        radius: 65 + (idx % 6) * 44
      }));
    },

    resize() {
      const canvas = $('ambient-canvas');
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = Math.floor(window.innerWidth * dpr);
      const h = Math.floor(window.innerHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      if (!this.particles.length) this.initParticles(w, h);
    },

    setTheme(theme) {
      state.canvasTheme = theme;
      document.querySelectorAll('[data-canvas-theme]').forEach((btn) => {
        btn.classList.toggle('is-active', btn.dataset.canvasTheme === theme);
      });

      const canvas = $('ambient-canvas');
      if (!canvas) return;
      const reducedMotion = Boolean(
        window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      );

      if (theme === 'off' || reducedMotion) {
        if (this.rafId) {
          cancelAnimationFrame(this.rafId);
          this.rafId = null;
        }
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }

      this.resize();
      if (!this.rafId) {
        const loop = () => {
          const stillReduced = Boolean(
            window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
          );
          if (state.canvasTheme === 'off' || stillReduced) {
            this.rafId = null;
            const ctx = canvas.getContext('2d');
            if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
            return;
          }
          this.draw();
          this.rafId = requestAnimationFrame(loop);
        };
        this.rafId = requestAnimationFrame(loop);
      }
    },

    draw() {
      const canvas = $('ambient-canvas');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const w = canvas.width;
      const h = canvas.height;
      const audioBoost = state.audioMode === 'off' ? 1 : 1 + Math.min(0.9, state.audioVolume * 2.4);
      this.t += 0.012 * audioBoost;

      ctx.clearRect(0, 0, w, h);

      if (state.canvasTheme === 'aurora') {
        const pulse = 0.5 + 0.5 * Math.sin(this.t * 0.85);
        const cx = w * (0.5 + 0.08 * Math.sin(this.t * 0.35));
        const cy = h * (0.35 + 0.06 * Math.cos(this.t * 0.25));
        const r = Math.max(w, h) * (0.38 + 0.08 * pulse);
        const grad = ctx.createRadialGradient(cx, cy, 10, cx, cy, r);
        const alpha = (0.06 + 0.05 * pulse) * audioBoost;
        grad.addColorStop(0, `rgba(94, 234, 212, ${Math.min(0.2, alpha)})`);
        grad.addColorStop(0.55, `rgba(56, 189, 248, ${Math.min(0.1, alpha * 0.6)})`);
        grad.addColorStop(1, 'rgba(6, 7, 10, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
      } else if (state.canvasTheme === 'rain') {
        ctx.lineWidth = 1;
        for (const p of this.particles) {
          p.y += p.speed * 1.4 * audioBoost;
          if (p.y - p.len > h) {
            p.y = -p.len;
            p.x = Math.random() * w;
          }
          ctx.strokeStyle = `rgba(94, 234, 212, ${state.audioMode === 'off' ? 0.14 : 0.24})`;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x, p.y + p.len);
          ctx.stroke();
        }
      } else if (state.canvasTheme === 'orbit') {
        const cx = w / 2;
        const cy = h / 2;
        const scale = Math.min(w, h) / 620;
        for (let ring = 1; ring <= 4; ring += 1) {
          ctx.strokeStyle = 'rgba(94, 234, 212, 0.06)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(cx, cy, ring * 68 * scale, 0, Math.PI * 2);
          ctx.stroke();
        }
        for (const p of this.particles) {
          p.angle += 0.0022 * p.speed * audioBoost;
          const rx = cx + Math.cos(p.angle) * p.radius * scale;
          const ry = cy + Math.sin(p.angle) * p.radius * scale;
          ctx.fillStyle = `rgba(94, 234, 212, ${state.audioMode === 'off' ? 0.22 : 0.36})`;
          ctx.beginPath();
          ctx.arc(rx, ry, 1.8, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (state.canvasTheme === 'ribbon') {
        // Subtle perspective grid below horizon
        const horizonY = h * 0.56;
        const vanishX = w * 0.5;
        ctx.save();
        ctx.strokeStyle = 'rgba(94, 234, 212, 0.05)';
        ctx.lineWidth = 1;

        for (let i = -6; i <= 6; i += 1) {
          const bottomX = vanishX + i * (w * 0.14);
          ctx.beginPath();
          ctx.moveTo(vanishX + i * 18, horizonY);
          ctx.lineTo(bottomX, h);
          ctx.stroke();
        }

        for (let row = 0; row < 6; row += 1) {
          const frac = Math.pow((row + 1) / 6, 1.7);
          const y = horizonY + frac * (h - horizonY);
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }

        // Flowing luminous cyan-to-violet wave ribbons
        const ribbonGrad = ctx.createLinearGradient(0, 0, w, 0);
        ribbonGrad.addColorStop(0, 'rgba(34, 211, 238, 0.28)');
        ribbonGrad.addColorStop(0.5, 'rgba(99, 102, 241, 0.32)');
        ribbonGrad.addColorStop(1, 'rgba(168, 85, 247, 0.28)');

        ctx.shadowBlur = 16;
        ctx.shadowColor = 'rgba(139, 92, 246, 0.26)';
        ctx.strokeStyle = ribbonGrad;

        for (let layer = 0; layer < 3; layer += 1) {
          const baseY = h * (0.4 + layer * 0.055);
          const amp = (24 + layer * 10) * audioBoost;
          const phase = this.t * (0.65 + layer * 0.14) + layer * 1.3;
          ctx.lineWidth = 2.1 - layer * 0.45;
          ctx.globalAlpha = (0.72 - layer * 0.16) * Math.min(1.25, audioBoost);

          ctx.beginPath();
          const steps = 48;
          for (let s = 0; s <= steps; s += 1) {
            const u = s / steps;
            const x = u * w;
            const y =
              baseY +
              Math.sin(u * Math.PI * 2.4 + phase) * amp +
              Math.cos(u * Math.PI * 1.2 - phase * 0.7) * (amp * 0.45);
            if (s === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  };

  const CURATED_LECTURES = [
    {
      video_id: 'eMlx5fFNoYc',
      title: 'Attention in Transformers, step-by-step',
      author: '3Blue1Brown',
      tags: 'ai transformers attention deep learning'
    },
    {
      video_id: 'aircAruvnKk',
      title: 'But what is a neural network?',
      author: '3Blue1Brown',
      tags: 'ai neural networks ml calculus'
    },
    {
      video_id: 'cQP8WApzIQQ',
      title: 'MIT 6.824 Distributed Systems: Lecture 1',
      author: 'MIT OpenCourseWare',
      tags: 'cs distributed systems mit mapreduce'
    },
    {
      video_id: 'HtSuA80QTyo',
      title: 'MIT 6.006 Algorithms: Algorithmic Thinking',
      author: 'MIT OpenCourseWare',
      tags: 'cs dsa algorithms vtu data structures'
    },
    {
      video_id: 'fNk_zzaMoSs',
      title: 'Vectors & Linear Algebra Essence',
      author: '3Blue1Brown',
      tags: 'math linear algebra vtu vectors matrices'
    },
    {
      video_id: 'oeYBdghaIjc',
      title: 'CMU 15-445 Relational Model & SQL',
      author: 'CMU Database Group',
      tags: 'cs dbms sql databases vtu'
    }
  ];

  // --- Utilities ---
  const $ = (id) => document.getElementById(id);

  function formatSec(totalSec) {
    const sec = Math.max(0, Math.floor(Number(totalSec) || 0));
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const rem = sec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(rem)}` : `${pad(mins)}:${pad(rem)}`;
  }

  function parseTimestampInput(raw) {
    const clean = String(raw || '').trim();
    if (/^\d+$/.test(clean)) return Math.max(0, Number.parseInt(clean, 10));
    const parts = clean.split(':').map((p) => Number.parseInt(p, 10));
    if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  function extractYouTubeId(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
    const bareCandidate = raw.split(/[?&#/]/)[0];
    if (!raw.includes('.') && /^[A-Za-z0-9_-]{11}$/.test(bareCandidate)) {
      return bareCandidate;
    }

    try {
      const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
      if (url.hostname.includes('youtu.be')) {
        const seg = url.pathname.split('/').filter(Boolean)[0];
        return seg && /^[A-Za-z0-9_-]{11}$/.test(seg) ? seg : null;
      }
      if (url.hostname.includes('youtube.com') || url.hostname.includes('youtube-nocookie.com')) {
        const v = url.searchParams.get('v');
        if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length >= 2 && ['embed', 'shorts', 'live', 'v'].includes(parts[0])) {
          return /^[A-Za-z0-9_-]{11}$/.test(parts[1]) ? parts[1] : null;
        }
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Lightweight XSS-safe Markdown subset renderer for study notes.
   */
  function renderSafeMarkdown(text) {
    const escaped = escapeHtml(text);
    const lines = escaped.split(/\r?\n/);
    const htmlParts = [];
    let inList = false;

    const inlineFormat = (line) =>
      line
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>');

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        if (inList) {
          htmlParts.push('</ul>');
          inList = false;
        }
        continue;
      }
      if (line.startsWith('- ') || line.startsWith('* ')) {
        if (!inList) {
          htmlParts.push('<ul>');
          inList = true;
        }
        htmlParts.push(`<li>${inlineFormat(line.slice(2))}</li>`);
      } else {
        if (inList) {
          htmlParts.push('</ul>');
          inList = false;
        }
        if (line.startsWith('### ')) {
          htmlParts.push(`<p><strong>${inlineFormat(line.slice(4))}</strong></p>`);
        } else {
          htmlParts.push(`<p>${inlineFormat(line)}</p>`);
        }
      }
    }
    if (inList) htmlParts.push('</ul>');
    return htmlParts.join('');
  }

  let toastTimer = null;
  function showToast(message) {
    const el = $('hud-toast');
    el.textContent = message;
    el.classList.remove('is-hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('is-hidden'), 2800);
  }

  async function api(url, options = {}) {
    const { headers, ...rest } = options;
    const res = await fetch(url, {
      ...rest,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error?.message || data.error || `Request failed (${res.status})`;
      throw new Error(msg);
    }
    return data;
  }

  // --- View & Stage Navigation ---
  function switchView(viewName) {
    state.activeView = viewName;
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.view === viewName);
    });
    document.querySelectorAll('.view-panel').forEach((panel) => {
      panel.classList.toggle('is-active', panel.id === `view-${viewName}`);
    });
    if (viewName === 'telemetry') {
      loadTelemetryAndVault();
    }
  }

  function showFocusStage(stageName) {
    state.focusStage = stageName;
    ['gate', 'micro', 'sprint', 'reflection'].forEach((s) => {
      $(`stage-${s}`).classList.toggle('is-visible', s === stageName);
    });
  }

  function updateHalo(circleId, ratio) {
    const el = $(circleId);
    if (!el) return;
    const clamped = Math.max(0, Math.min(1, ratio));
    el.style.strokeDasharray = `${HALO_CIRCUMFERENCE}`;
    el.style.strokeDashoffset = `${HALO_CIRCUMFERENCE * (1 - clamped)}`;
  }

  function syncAudioButtons() {
    if (state.audioMode !== 'off') {
      state.lastActiveAudioMode = state.audioMode;
    }
    document.querySelectorAll('[data-audio]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.audio === state.audioMode);
    });
    if ($('topbar-audio-select')) {
      $('topbar-audio-select').value = state.audioMode;
    }
    if ($('topbar-audio-mute')) {
      const isMuted = state.audioMode === 'off';
      $('topbar-audio-mute').textContent = isMuted ? 'Muted' : 'Mute';
      $('topbar-audio-mute').classList.toggle('is-active', !isMuted);
    }
  }

  // --- View 1: Focus Gate, 2m Micro-Commitment, Deep Sprint, Reflection ---
  function clearFocusTimer() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
  }

  async function enterMicroGate(intention, minutes, strictMode = false, taskId = state.activeTaskId) {
    state.strictMode = Boolean(strictMode);
    state.activeTaskId = taskId || null;
    state.sprintTabSwitches = 0;
    state.sprintBreaches = 0;

    const created = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        intention,
        target_minutes: minutes,
        actual_minutes: 0,
        status: 'active',
        strict_mode: state.strictMode,
        task_id: state.activeTaskId
      })
    });

    state.currentSession = created.session;
    state.timerPaused = false;
    state.microRemainingSec = MICRO_GATE_SECONDS;
    state.microTotalSec = MICRO_GATE_SECONDS;
    state.sprintTotalSec = minutes * 60;
    state.sprintRemainingSec = minutes * 60;
    state.sprintElapsedSec = 0;

    $('micro-intention-text').textContent = intention;
    $('micro-target-label').textContent = `${minutes}m`;
    $('micro-pause-btn').textContent = 'Pause';
    $('micro-strict-badge').classList.toggle('is-hidden', !state.strictMode);
    $('micro-breach-banner').classList.add('is-hidden');
    $('sprint-breach-banner').classList.add('is-hidden');
    renderMicroTick();
    showFocusStage('micro');

    if (state.strictMode && document.documentElement.requestFullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {
        showToast('Strict Lock active (tab-switch monitoring enabled).');
      });
    }

    clearFocusTimer();
    state.timerInterval = setInterval(() => {
      if (state.timerPaused || state.focusStage !== 'micro') return;
      state.microRemainingSec -= 1;
      renderMicroTick();
      if (state.microRemainingSec <= 0) {
        audioEngine.chime();
        enterDeepSprint();
      }
    }, 1000);
  }

  function renderMicroTick() {
    $('micro-time-display').textContent = formatSec(state.microRemainingSec);
    const meta = [];
    if (state.sprintTabSwitches > 0) meta.push(`${state.sprintTabSwitches} OFF-TAB`);
    if (state.sprintBreaches > 0) meta.push(`${state.sprintBreaches} BREACH`);
    $('micro-elapsed-meta').textContent = meta.length ? meta.join(' · ') : 'ENTRY THRESHOLD';
    updateHalo('micro-halo-circle', state.microRemainingSec / Math.max(1, state.microTotalSec));
  }

  function enterDeepSprint() {
    clearFocusTimer();
    state.timerPaused = false;
    $('sprint-intention-text').textContent = state.currentSession?.intention || 'Deep Focus';
    $('sprint-pause-btn').textContent = 'Pause';
    $('sprint-strict-badge').classList.toggle('is-hidden', !state.strictMode);
    renderSprintTick();
    showFocusStage('sprint');
    showToast(`Deep Sprint locked (${state.selectedMinutes}m)`);

    state.timerInterval = setInterval(() => {
      if (state.timerPaused || state.focusStage !== 'sprint') return;
      state.sprintElapsedSec += 1;
      state.sprintRemainingSec = Math.max(0, state.sprintTotalSec - state.sprintElapsedSec);
      renderSprintTick();
      if (state.sprintRemainingSec <= 0) {
        audioEngine.chime();
        finishSprint('completed');
      }
    }, 1000);
  }

  function renderSprintTick() {
    $('sprint-time-display').textContent = formatSec(state.sprintRemainingSec);
    const elapsedMin = (state.sprintElapsedSec / 60).toFixed(1);
    const switchPart = state.sprintTabSwitches > 0 ? ` · ${state.sprintTabSwitches} OFF-TAB` : '';
    const breachPart = state.sprintBreaches > 0 ? ` · ${state.sprintBreaches} BREACH` : '';
    $('sprint-elapsed-meta').textContent = `${elapsedMin}m ELAPSED${switchPart}${breachPart}`;
    updateHalo('sprint-halo-circle', state.sprintRemainingSec / state.sprintTotalSec);
  }

  function computeActualMinutes() {
    return state.focusStage === 'sprint'
      ? Number(Math.max(0.1, state.sprintElapsedSec / 60).toFixed(1))
      : Number(Math.max(0, (MICRO_GATE_SECONDS - state.microRemainingSec) / 60).toFixed(1));
  }

  function syncSessionTelemetryNow(keepalive = false) {
    if (!state.currentSession) return;
    const payload = JSON.stringify({
      actual_minutes: computeActualMinutes(),
      tab_switches: state.sprintTabSwitches,
      breaches: state.sprintBreaches
    });
    fetch(`/api/sessions/${state.currentSession.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive
    }).catch(() => {});
  }

  function handleFocusLoss(reason) {
    if (state.timerPaused) return;
    if (state.focusStage !== 'micro' && state.focusStage !== 'sprint') return;

    const now = Date.now();
    if (now - state.lastTabSwitchAt < 750) return;
    state.lastTabSwitchAt = now;

    state.sprintTabSwitches += 1;
    if (state.strictMode) {
      recordStrictBreach(reason);
    } else if (state.focusStage === 'micro') {
      renderMicroTick();
    } else {
      renderSprintTick();
    }
    syncSessionTelemetryNow(false);
  }

  function recordStrictBreach(reason) {
    if (!state.strictMode) return;
    if (state.focusStage !== 'micro' && state.focusStage !== 'sprint') return;
    if (state.timerPaused) return;

    state.sprintBreaches += 1;
    if (state.focusStage === 'micro') {
      state.microRemainingSec += 120;
      state.microTotalSec += 120;
    } else {
      state.sprintRemainingSec += 120;
      state.sprintTotalSec += 120;
    }
    audioEngine.softBell();

    const msg = `STRICT PENALTY: +2:00 ADDED FOR OFF-TAB SWITCH (${reason} · Breach #${state.sprintBreaches})`;
    const activeBanner = state.focusStage === 'micro' ? $('micro-breach-banner') : $('sprint-breach-banner');
    if (activeBanner) {
      activeBanner.textContent = msg;
      activeBanner.classList.remove('is-hidden');
    }

    if (state.focusStage === 'micro') renderMicroTick();
    else renderSprintTick();
  }

  async function finishSprint(status) {
    clearFocusTimer();
    $('early-complete-confirm')?.classList.add('is-hidden');
    if (state.audioMode !== 'off') {
      audioEngine.setMode('off');
    }

    if (document.fullscreenElement && document.exitFullscreen) {
      state.exitingFullscreenCleanly = true;
      document.exitFullscreen().catch(() => {}).finally(() => {
        state.exitingFullscreenCleanly = false;
      });
    }

    const actualMinutes = computeActualMinutes();

    if (state.currentSession) {
      try {
        const res = await api(`/api/sessions/${state.currentSession.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status,
            actual_minutes: actualMinutes,
            tab_switches: state.sprintTabSwitches,
            breaches: state.sprintBreaches
          })
        });
        state.currentSession = res.session;
        if (res.task) {
          refreshTasks();
        }
      } catch (err) {
        showToast(`Sync error: ${err.message}`);
      }
    }

    const pill = $('reflection-status-pill');
    pill.textContent = status.toUpperCase();
    pill.className = `mono-pill ${status === 'completed' ? 'accent' : 'danger'}`;

    $('reflection-intention-title').textContent = state.currentSession?.intention || 'Session Logged';
    $('reflection-target').textContent = `${state.selectedMinutes}m`;
    $('reflection-actual').textContent = `${actualMinutes}m`;
    $('reflection-outcome').textContent = status.toUpperCase();
    $('reflection-input').value = '';
    showFocusStage('reflection');
  }

  function resetGate() {
    clearFocusTimer();
    state.currentSession = null;
    state.activeTaskId = null;
    state.strictMode = false;
    state.sprintTabSwitches = 0;
    state.sprintBreaches = 0;
    $('intention-input').value = '';
    $('barrier-confirm').checked = false;
    $('strict-mode-toggle').checked = false;
    $('gate-error').textContent = '';
    $('micro-breach-banner').classList.add('is-hidden');
    $('sprint-breach-banner').classList.add('is-hidden');
    $('early-complete-confirm')?.classList.add('is-hidden');
    showFocusStage('gate');
  }

  // --- View 2: FocusTube Study Workspace ---
  function startStudyClock() {
    if (state.studyClockInterval) return;
    state.studyClockRunning = true;
    $('clock-toggle-btn').textContent = 'Pause Clock';
    state.studyClockInterval = setInterval(() => {
      if (!state.studyClockRunning) return;
      state.studyClockSec += 1;
      syncStudyClockUI();
    }, 1000);
  }

  function pauseStudyClock() {
    state.studyClockRunning = false;
    $('clock-toggle-btn').textContent = 'Start Clock';
  }

  function syncStudyClockUI() {
    $('study-clock-display').textContent = formatSec(state.studyClockSec);
    if (state.lockedTimestampSec === null) {
      $('note-active-ts').textContent = `@ ${formatSec(state.studyClockSec)}`;
    }
  }

  function seekStreamTo(sec) {
    const targetSec = Math.max(0, Math.floor(sec));
    state.studyClockSec = targetSec;
    syncStudyClockUI();

    const iframe = $('yt-iframe');
    if (iframe && !iframe.classList.contains('is-hidden') && iframe.contentWindow) {
      iframe.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: 'seekTo', args: [targetSec, true] }),
        '*'
      );
    }
  }

  async function fetchYouTubeOEmbed(videoId, rawUrl) {
    const canonicalUrl = rawUrl && rawUrl.startsWith('http')
      ? rawUrl
      : `https://www.youtube.com/watch?v=${videoId}`;
    const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const res = await fetch(endpoint, { signal: controller.signal });
      if (!res.ok) return null;
      const data = await res.json();
      return {
        title: typeof data.title === 'string' ? data.title.trim() : '',
        author: typeof data.author_name === 'string' ? data.author_name.trim() : ''
      };
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadFocusTubeStream(rawUrlOrId, customTitle = '', customAuthor = '') {
    const id = extractYouTubeId(rawUrlOrId);
    if (!id) {
      showToast('Enter a valid YouTube URL or 11-character video ID.');
      return;
    }

    const explicitTitle = customTitle.trim();
    state.videoId = id;
    state.videoTitle = explicitTitle || `Study Stream (${id})`;
    state.videoAuthor = customAuthor.trim();

    $('yt-url-input').value = rawUrlOrId;
    $('yt-title-input').value = explicitTitle ? state.videoTitle : '';
    $('active-video-title').textContent = state.videoTitle;
    $('active-video-author').textContent = state.videoAuthor ? `by ${state.videoAuthor}` : '';
    $('active-video-id').textContent = id;

    const originParam = encodeURIComponent(window.location.origin);
    const src = `https://www.youtube-nocookie.com/embed/${id}?rel=0&modestbranding=1&iv_load_policy=3&enablejsapi=1&origin=${originParam}`;
    const iframe = $('yt-iframe');
    iframe.src = src;
    iframe.classList.remove('is-hidden');
    $('player-empty-state').classList.add('is-hidden');

    state.studyClockSec = 0;
    state.lockedTimestampSec = null;
    syncStudyClockUI();
    startStudyClock();

    await refreshVideoNotes();

    if (!explicitTitle) {
      const meta = await fetchYouTubeOEmbed(id, rawUrlOrId);
      if (meta && state.videoId === id) {
        if (meta.title) {
          state.videoTitle = meta.title;
          $('yt-title-input').value = meta.title;
          $('active-video-title').textContent = meta.title;
        }
        if (meta.author) {
          state.videoAuthor = meta.author;
          $('active-video-author').textContent = `by ${meta.author}`;
        }
      }
    }

    showToast(`Loaded clean stream: ${state.videoTitle}`);
  }

  async function refreshStudyQueue() {
    try {
      const data = await api('/api/queue');
      state.studyQueue = data.queue || [];
      renderStudyQueue();
    } catch (_) {
      // ignore initial offline failure
    }
  }

  function renderStudyQueue() {
    const container = $('study-queue-list');
    if (!container) return;
    if (!state.studyQueue.length) {
      container.innerHTML = `<div class="empty-notes-state">Queue is empty. Paste a YouTube URL above and click + Queue to line up lectures.</div>`;
      return;
    }

    container.innerHTML = state.studyQueue
      .map((item) => {
        const sub = item.author_name
          ? `${escapeHtml(item.author_name)} · ${escapeHtml(item.video_id)}`
          : escapeHtml(item.video_id);
        return `
          <div class="queue-item ${item.completed ? 'is-completed' : ''}">
            <div class="queue-item-left">
              <input
                type="checkbox"
                class="queue-check"
                data-queue-toggle="${item.id}"
                ${item.completed ? 'checked' : ''}
                aria-label="Mark ${escapeHtml(item.video_title)} completed"
              />
              <div class="queue-meta">
                <div class="queue-title">${escapeHtml(item.video_title)}</div>
                <div class="queue-sub mono">${sub}</div>
              </div>
            </div>
            <div class="queue-item-actions">
              <button
                type="button"
                class="btn-ghost btn-sm"
                data-open-video="${escapeHtml(item.video_id)}"
                data-open-title="${escapeHtml(item.video_title)}"
                data-open-author="${escapeHtml(item.author_name || '')}"
              >Load</button>
              <button
                type="button"
                class="btn-danger-ghost btn-sm"
                data-queue-delete="${item.id}"
                title="Remove from queue"
              >&times;</button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  async function addCurrentInputToQueue() {
    const rawInput = $('yt-url-input').value.trim();
    const fallbackId = state.videoId || '';
    const id = extractYouTubeId(rawInput) || fallbackId;
    if (!id) {
      showToast('Paste a YouTube URL/ID or load a stream first.');
      return;
    }

    let title = $('yt-title-input').value.trim() || (id === state.videoId ? state.videoTitle : '');
    let author = id === state.videoId ? state.videoAuthor : '';
    if (!title || title === `Study Stream (${id})`) {
      const meta = await fetchYouTubeOEmbed(id, rawInput);
      if (meta) {
        if (meta.title) {
          title = meta.title;
          $('yt-title-input').value = title;
        }
        if (meta.author) author = meta.author;
      }
    }

    const canonicalUrl = /^https?:\/\//i.test(rawInput)
      ? rawInput
      : `https://www.youtube.com/watch?v=${id}`;

    try {
      await api('/api/queue', {
        method: 'POST',
        body: JSON.stringify({
          video_id: id,
          video_title: title || `Study Stream (${id})`,
          author_name: author || '',
          url: canonicalUrl
        })
      });
      await refreshStudyQueue();
      showToast(`Queued: ${title || id}`);
    } catch (err) {
      showToast(err.message);
    }
  }

  function renderTopicLauncher(query = '') {
    const container = $('topic-results');
    if (!container) return;
    const q = query.trim().toLowerCase();

    const maybeId = extractYouTubeId(query);
    if (maybeId && q.length >= 11) {
      container.innerHTML = `
        <div class="topic-card">
          <div class="topic-card-meta">
            <span class="topic-card-title">Detected Stream ID: ${escapeHtml(maybeId)}</span>
            <span class="topic-card-sub">READY TO ISOLATE</span>
          </div>
          <button type="button" class="btn-primary btn-sm" data-open-video="${escapeHtml(maybeId)}">Load</button>
          <button type="button" class="btn-ghost btn-sm" data-queue-preset="${escapeHtml(maybeId)}" data-queue-title="Study Stream (${escapeHtml(maybeId)})" data-queue-author="">+ Queue</button>
        </div>
      `;
      return;
    }

    const matches = q
      ? CURATED_LECTURES.filter((item) =>
          `${item.title} ${item.author} ${item.tags}`.toLowerCase().includes(q)
        )
      : CURATED_LECTURES;

    const cardsHtml = matches
      .map(
        (item) => `
        <div class="topic-card">
          <div class="topic-card-meta">
            <span class="topic-card-title">${escapeHtml(item.title)}</span>
            <span class="topic-card-sub">${escapeHtml(item.author)} · ${escapeHtml(item.video_id)}</span>
          </div>
          <button type="button" class="btn-ghost btn-sm" data-open-video="${escapeHtml(item.video_id)}" data-open-title="${escapeHtml(item.title)}" data-open-author="${escapeHtml(item.author)}">Load</button>
          <button type="button" class="btn-ghost btn-sm" data-queue-preset="${escapeHtml(item.video_id)}" data-queue-title="${escapeHtml(item.title)}" data-queue-author="${escapeHtml(item.author)}">+</button>
        </div>`
      )
      .join('');

    const fallbackLink = q
      ? `<a class="topic-external-link" href="https://www.youtube.com/results?search_query=${encodeURIComponent(query.trim())}" target="_blank" rel="noopener noreferrer">Lookup "${escapeHtml(query.trim())}" &amp; paste URL back</a>`
      : '';

    container.innerHTML = cardsHtml + fallbackLink;
  }

  async function refreshVideoNotes() {
    if (!state.videoId) return;
    const data = await api(`/api/notes?video_id=${encodeURIComponent(state.videoId)}`);
    state.notesForVideo = data.notes || [];
    if (state.notesForVideo.length > 0 && !$('yt-title-input').value.trim()) {
      state.videoTitle = state.notesForVideo[0].video_title;
      $('active-video-title').textContent = state.videoTitle;
    }
    renderVideoNotesTimeline();
  }

  function renderVideoNotesTimeline() {
    const container = $('notes-timeline');
    if (!state.notesForVideo.length) {
      container.innerHTML = `<div class="empty-notes-state">No notes yet for <code>${escapeHtml(state.videoId || 'stream')}</code>. Capture your first timestamped anchor above.</div>`;
      return;
    }

    container.innerHTML = state.notesForVideo
      .map((note) => {
        const tsLabel = formatSec(note.timestamp_sec);
        const created = new Date(note.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `
          <article class="note-item">
            <div class="note-item-head">
              <button type="button" class="ts-jump-btn" data-seek-sec="${note.timestamp_sec}" title="Jump to ${tsLabel}">
                @ ${tsLabel}
              </button>
              <div class="note-item-meta-actions">
                <span class="note-time-meta mono">${escapeHtml(created)}</span>
                <button type="button" class="btn-danger-ghost btn-sm" data-note-delete="${note.id}" title="Delete note">&times;</button>
              </div>
            </div>
            <div class="note-body">${renderSafeMarkdown(note.note_text)}</div>
          </article>
        `;
      })
      .join('');
  }

  function formatNotesAsMarkdown(videoTitle, videoId, notes) {
    const lines = [
      `# ${videoTitle || `Study Stream (${videoId})`}`,
      `- Video ID: \`${videoId}\``,
      `- Exported: ${new Date().toISOString()}`,
      '',
      '## Timestamped Notes',
      ''
    ];
    for (const n of notes) {
      lines.push(`- **[${formatSec(n.timestamp_sec)}]** ${n.note_text.replace(/\n+/g, '  \n  ')}`);
    }
    return lines.join('\n');
  }

  function downloadMarkdownFile(filename, content) {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function runCoach(mode = 'study_pack') {
    const output = $('coach-output');
    if (!state.videoId && state.notesForVideo.length === 0) {
      showToast('Load a stream or add study notes first.');
      return;
    }

    output.innerHTML = `<div class="coach-empty mono">Running DOSHE Local Study Coach (${escapeHtml(mode)})...</div>`;
    try {
      const payload = await api('/api/coach', {
        method: 'POST',
        body: JSON.stringify({
          mode,
          video_id: state.videoId,
          video_title: state.videoTitle,
          notes: state.notesForVideo.map((n) => ({
            timestamp_sec: n.timestamp_sec,
            note_text: n.note_text
          })),
          intention: state.currentSession?.intention || ''
        })
      });

      $('coach-meta-badge').textContent = `${payload.api_version.toUpperCase()} · ${payload.latency_ms}ms · ${payload.engine}`;
      renderCoachOutput(payload);
    } catch (err) {
      output.innerHTML = `<div class="coach-empty hint-text">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderCoachOutput(data) {
    const blocks = [];

    if (data.summary) {
      const s = data.summary;
      const takeawaysHtml = (s.key_takeaways || [])
        .map((t) => `<li>${escapeHtml(t)}</li>`)
        .join('');
      const conceptHtml = (s.concept_map || [])
        .map(
          (c) => `
          <div class="concept-row">
            <button type="button" class="ts-jump-btn" data-seek-sec="${c.timestamp_sec}">${escapeHtml(c.timestamp_label)}</button>
            <div><strong>${escapeHtml(c.term)}</strong> — ${escapeHtml(c.context)}</div>
          </div>`
        )
        .join('');
      const actionsHtml = (s.action_items || [])
        .map((a) => `<li>${escapeHtml(a)}</li>`)
        .join('');

      blocks.push(`
        <div class="coach-block">
          <h3>// SYNTHESIS BRIEF</h3>
          <p><strong>${escapeHtml(s.headline)}</strong></p>
          <p>${escapeHtml(s.executive_brief)}</p>
          <h3>// KEY TAKEAWAYS</h3>
          <ul class="coach-list">${takeawaysHtml}</ul>
        </div>
        <div class="coach-block">
          <h3>// TIMESTAMP CONCEPT MAP</h3>
          <div class="concept-chip-list">${conceptHtml}</div>
          <h3 style="margin-top:14px;">// NEXT ACTIONS</h3>
          <ul class="coach-list">${actionsHtml}</ul>
        </div>
      `);
    }

    if (data.quiz && data.quiz.length > 0) {
      const quizHtml = data.quiz
        .map((q) => {
          const opts = q.options
            .map(
              (opt, idx) => `
              <button
                type="button"
                class="quiz-opt-btn"
                data-quiz-id="${escapeHtml(q.id)}"
                data-opt-idx="${idx}"
                data-answer-idx="${q.answer_index}"
              >${escapeHtml(opt)}</button>`
            )
            .join('');
          return `
            <div class="quiz-card" id="quiz-card-${escapeHtml(q.id)}">
              <div class="quiz-prompt">
                <button type="button" class="ts-jump-btn" data-seek-sec="${q.timestamp_sec}">${escapeHtml(q.timestamp_label)}</button>
                ${escapeHtml(q.prompt)}
              </div>
              <div class="quiz-options">${opts}</div>
              <div class="quiz-explanation is-hidden" id="quiz-exp-${escapeHtml(q.id)}">${escapeHtml(q.explanation)}</div>
            </div>
          `;
        })
        .join('');

      blocks.push(`
        <div class="coach-block">
          <h3>// ACTIVE RECALL QUIZ</h3>
          ${quizHtml}
        </div>
      `);
    }

    $('coach-output').innerHTML = `<div class="coach-grid">${blocks.join('')}</div>`;
  }

  // --- View 3: Telemetry & Session History ---
  async function loadTelemetryAndVault() {
    try {
      const [sessRes, notesRes] = await Promise.all([
        api('/api/sessions?limit=60'),
        api('/api/notes')
      ]);

      state.sessions = sessRes.sessions || [];
      state.telemetry = sessRes.telemetry || null;
      state.allNotes = notesRes.notes || [];

      renderTelemetryMetrics();
      renderSessionsList();
      renderVaultNotes();
      renderRecentStreamPills();
    } catch (err) {
      showToast(`Telemetry load failed: ${err.message}`);
    }
  }

  function renderTelemetryMetrics() {
    const t = state.telemetry;
    if (!t) return;

    $('metric-total-minutes').textContent = `${t.total_deep_focus_minutes}m`;
    $('metric-total-hours').textContent = `${(t.total_deep_focus_minutes / 60).toFixed(1)} hrs logged`;
    $('metric-completion-rate').textContent = `${t.intent_completion_rate}%`;
    $('metric-completion-bar').style.width = `${t.intent_completion_rate}%`;
    $('metric-completion-ratio').textContent = `${t.completed_sessions} completed / ${t.abandoned_sessions} abandoned`;

    const integrity = t.focus_integrity_pct ?? 100;
    const switches = t.total_tab_switches ?? 0;
    const breaches = t.total_breaches ?? 0;
    $('metric-focus-integrity').textContent = `${integrity}%`;
    $('metric-integrity-bar').style.width = `${integrity}%`;
    $('metric-integrity-sub').textContent = `${switches} off-tab · ${breaches} strict breach${breaches === 1 ? '' : 'es'}`;

    const resisted = t.urges_resisted ?? 0;
    const totalUrges = t.total_urges ?? 0;
    $('metric-urges-resisted').textContent = `${resisted}`;
    $('metric-urges-sub').textContent = `${totalUrges} impulse shield${totalUrges === 1 ? '' : 's'} triggered`;

    $('metric-total-notes').textContent = `${t.total_notes}`;
    $('metric-total-sessions').textContent = `${t.total_sessions} sessions · ${t.total_videos} streams`;

    // 7-day cadence chart
    const byDay = new Map((t.daily_cadence || []).map((d) => [d.day, d.minutes]));
    const days = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
      const d = new Date(Date.now() - offset * 86400000);
      const key = d.toISOString().slice(0, 10);
      days.push({ key, label: key.slice(5), minutes: byDay.get(key) || 0 });
    }
    const maxMin = Math.max(15, ...days.map((d) => d.minutes));
    $('cadence-chart').innerHTML = days
      .map((d) => {
        const pct = Math.max(4, Math.round((d.minutes / maxMin) * 100));
        return `
          <div class="cadence-col" title="${d.key}: ${d.minutes}m">
            <div class="cadence-bar" style="height:${pct}%"></div>
            <span class="cadence-day">${d.label}</span>
          </div>
        `;
      })
      .join('');
  }

  function renderSessionsList() {
    const list = $('sessions-list');
    const filtered = state.sessionFilter === 'all'
      ? state.sessions
      : state.sessions.filter((s) => s.status === state.sessionFilter);

    if (!filtered.length) {
      list.innerHTML = `<div class="empty-notes-state">No focus sessions recorded for this filter.</div>`;
      return;
    }

    list.innerHTML = filtered
      .map((s) => {
        const pillClass = s.status === 'completed' ? 'accent' : s.status === 'abandoned' ? 'danger' : '';
        const when = new Date(s.created_at).toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
        return `
          <article class="session-row">
            <div class="session-row-top">
              <span class="session-intention">${escapeHtml(s.intention)}</span>
              <div style="display:flex;gap:6px;align-items:center;">
                ${s.breaches > 0 ? `<span class="mono-pill danger">BREACH ×${s.breaches}</span>` : ''}
                <span class="mono-pill ${pillClass}">${escapeHtml(s.status.toUpperCase())}</span>
              </div>
            </div>
            <div class="session-meta mono">
              <span>ACTUAL: ${s.actual_minutes}m / ${s.target_minutes}m</span>
              <span>OFF-TAB: ${s.tab_switches ?? 0}</span>
              ${s.strict_mode ? '<span>STRICT LOCK</span>' : ''}
              <span>${escapeHtml(when)}</span>
            </div>
            ${s.reflection ? `<div class="session-reflection">${escapeHtml(s.reflection)}</div>` : ''}
          </article>
        `;
      })
      .join('');
  }

  function groupNotesByVideo(notes) {
    const map = new Map();
    for (const n of notes) {
      if (!map.has(n.video_id)) {
        map.set(n.video_id, { video_id: n.video_id, video_title: n.video_title, notes: [] });
      }
      map.get(n.video_id).notes.push(n);
    }
    for (const group of map.values()) {
      group.notes.sort((a, b) => a.timestamp_sec - b.timestamp_sec);
    }
    return [...map.values()];
  }

  function renderVaultNotes() {
    const container = $('vault-notes-list');
    const groups = groupNotesByVideo(state.allNotes);
    if (!groups.length) {
      container.innerHTML = `<div class="empty-notes-state">No FocusTube study notes captured yet.</div>`;
      return;
    }

    container.innerHTML = groups
      .map((g) => {
        const previews = g.notes
          .map(
            (n) => `
            <div class="vault-note-preview">
              <span class="vault-note-text"><span class="mono">[${formatSec(n.timestamp_sec)}]</span> ${escapeHtml(n.note_text.slice(0, 100))}</span>
              <button type="button" class="btn-danger-ghost btn-sm" data-note-delete="${n.id}" title="Delete note">&times;</button>
            </div>`
          )
          .join('');
        return `
          <article class="vault-video-group">
            <div class="vault-group-head">
              <div>
                <strong>${escapeHtml(g.video_title)}</strong>
                <div class="mono note-time-meta">${escapeHtml(g.video_id)} · ${g.notes.length} notes</div>
              </div>
              <div class="vault-group-actions">
                <button type="button" class="btn-ghost btn-sm" data-open-video="${escapeHtml(g.video_id)}" data-open-title="${escapeHtml(g.video_title)}">Open</button>
                <button type="button" class="btn-ghost btn-sm" data-export-video="${escapeHtml(g.video_id)}">.md</button>
              </div>
            </div>
            ${previews}
          </article>
        `;
      })
      .join('');
  }

  function renderRecentStreamPills() {
    const bar = $('recent-streams-bar');
    const groups = groupNotesByVideo(state.allNotes).slice(0, 4);
    if (!groups.length) {
      bar.innerHTML = '';
      return;
    }
    bar.innerHTML = `<span class="mono note-time-meta">SAVED STREAMS:</span>` +
      groups
        .map(
          (g) => `<button type="button" class="chip-btn" data-open-video="${escapeHtml(g.video_id)}" data-open-title="${escapeHtml(g.video_title)}">${escapeHtml(g.video_title.slice(0, 28))} (${g.notes.length})</button>`
        )
        .join('');
  }

  // --- Ctrl+K Command Palette ---
  function getPaletteCommands(query) {
    const base = [
      { id: 'view-focus', label: 'Go to [01] Focus Gate', category: 'VIEW', run: () => switchView('focus') },
      { id: 'view-focustube', label: 'Go to [02] FocusTube Study Workspace', category: 'VIEW', run: () => switchView('focustube') },
      { id: 'view-telemetry', label: 'Go to [03] Telemetry & History', category: 'VIEW', run: () => switchView('telemetry') },
      { id: 'urge-shield', label: 'Trigger Urge Shield (15s Anti-Doomscroll Cooldown)', category: 'SHIELD', run: () => openUrgeShield() },
      { id: 'spotify-drawer', label: 'Toggle Spotify Focus Embed Drawer', category: 'AUDIO', run: () => toggleSpotifyDrawer() },
      { id: 'audio-brown', label: 'Acoustic Shield: Brown Noise', category: 'AUDIO', run: () => audioEngine.setMode('brown') },
      { id: 'audio-pink', label: 'Acoustic Shield: Pink Noise', category: 'AUDIO', run: () => audioEngine.setMode('pink') },
      { id: 'audio-rain', label: 'Acoustic Shield: Rain & Droplets', category: 'AUDIO', run: () => audioEngine.setMode('rain') },
      { id: 'audio-cafe', label: 'Acoustic Shield: Warm Café Murmur', category: 'AUDIO', run: () => audioEngine.setMode('cafe') },
      { id: 'audio-hall', label: 'Acoustic Shield: Exam Hall + 60 BPM Pulse', category: 'AUDIO', run: () => audioEngine.setMode('hall') },
      { id: 'audio-gamma', label: 'Acoustic Shield: 40Hz Gamma Binaural', category: 'AUDIO', run: () => audioEngine.setMode('gamma') },
      { id: 'audio-drone', label: 'Acoustic Shield: Synth Drone (110Hz/165Hz)', category: 'AUDIO', run: () => audioEngine.setMode('drone') },
      { id: 'audio-off', label: 'Acoustic Shield: Silence', category: 'AUDIO', run: () => audioEngine.setMode('off') },
      { id: 'canvas-aurora', label: 'Ambient Canvas: Breathing Aurora', category: 'VISUAL', run: () => ambientCanvas.setTheme('aurora') },
      { id: 'canvas-rain', label: 'Ambient Canvas: Rain Matrix', category: 'VISUAL', run: () => ambientCanvas.setTheme('rain') },
      { id: 'canvas-orbit', label: 'Ambient Canvas: Deep Orbit', category: 'VISUAL', run: () => ambientCanvas.setTheme('orbit') },
      { id: 'canvas-ribbon', label: 'Ambient Canvas: Neural Ribbon', category: 'VISUAL', run: () => ambientCanvas.setTheme('ribbon') },
      { id: 'canvas-off', label: 'Ambient Canvas: Off', category: 'VISUAL', run: () => ambientCanvas.setTheme('off') },
      {
        id: 'coach-pack',
        label: 'Run AI Study Coach (Summary + Quiz)',
        category: 'COACH',
        run: () => {
          switchView('focustube');
          runCoach('study_pack');
        }
      },
      {
        id: 'export-all',
        label: 'Export All Study Notes as Markdown',
        category: 'VAULT',
        run: () => exportAllNotesMarkdown()
      }
    ];

    const taskCmds = state.tasks
      .filter((t) => t.status === 'todo')
      .slice(0, 8)
      .map((t) => ({
        id: `task-${t.id}`,
        label: `Focus Task: ${t.title} [${t.tag}]`,
        category: t.is_top3 ? 'TOP-3' : 'TASK',
        run: () => focusTaskById(t.id)
      }));

    const streamCmds = groupNotesByVideo(state.allNotes).map((g) => ({
      id: `stream-${g.video_id}`,
      label: `Open Stream: ${g.video_title}`,
      category: 'STREAM',
      run: () => {
        switchView('focustube');
        loadFocusTubeStream(g.video_id, g.video_title);
      }
    }));

    const all = [...base, ...taskCmds, ...streamCmds];
    const q = query.trim().toLowerCase();
    return q ? all.filter((c) => c.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q)) : all;
  }

  function openCommandPalette() {
    $('cmd-backdrop').classList.remove('is-hidden');
    const input = $('cmd-search-input');
    input.value = '';
    state.cmdSelectedIndex = 0;
    renderCommandPaletteResults();
    input.focus();
  }

  function closeCommandPalette() {
    $('cmd-backdrop').classList.add('is-hidden');
  }

  function renderCommandPaletteResults() {
    const items = getPaletteCommands($('cmd-search-input').value);
    if (state.cmdSelectedIndex >= items.length) state.cmdSelectedIndex = 0;

    const list = $('cmd-results');
    if (!items.length) {
      list.innerHTML = `<div class="empty-notes-state">No matching commands.</div>`;
      return;
    }

    list.innerHTML = items
      .map(
        (item, idx) => `
        <button type="button" class="cmd-item ${idx === state.cmdSelectedIndex ? 'is-selected' : ''}" data-cmd-idx="${idx}">
          <span>${escapeHtml(item.label)}</span>
          <span class="cmd-item-cat">${escapeHtml(item.category)}</span>
        </button>`
      )
      .join('');
  }

  function exportAllNotesMarkdown() {
    const groups = groupNotesByVideo(state.allNotes);
    if (!groups.length) {
      showToast('No study notes available to export.');
      return;
    }
    const content = groups
      .map((g) => formatNotesAsMarkdown(g.video_title, g.video_id, g.notes))
      .join('\n\n---\n\n');
    downloadMarkdownFile(`doshe-study-vault-${new Date().toISOString().slice(0, 10)}.md`, content);
    showToast('Exported all study notes (.md)');
  }

  // --- Persistent To-Do & Daily Top-3 Task Engine ---
  async function refreshTasks() {
    try {
      const data = await api('/api/tasks');
      state.tasks = data.tasks || [];
      renderTasks();
    } catch (_) {
      // ignore offline startup probe
    }
  }

  function renderTaskRow(task) {
    const doneClass = task.status === 'done' ? 'is-done' : '';
    const topClass = task.is_top3 && task.status === 'todo' ? 'is-top3' : '';
    const starChar = task.is_top3 ? '★' : '☆';
    return `
      <div class="task-row ${topClass} ${doneClass}">
        <div class="task-row-left">
          <input
            type="checkbox"
            class="queue-check"
            data-task-toggle="${task.id}"
            ${task.status === 'done' ? 'checked' : ''}
            aria-label="Mark ${escapeHtml(task.title)} done"
          />
          <button
            type="button"
            class="task-star-btn ${task.is_top3 ? 'is-starred' : ''}"
            data-task-top3="${task.id}"
            title="${task.is_top3 ? 'Unpin from Daily Top-3' : 'Pin to Daily Top-3 (max 3)'}"
          >${starChar}</button>
          <div class="task-info">
            <div class="task-title">${escapeHtml(task.title)}</div>
            <div class="task-meta mono">
              <span class="task-tag-pill">${escapeHtml(task.tag)}</span>
              <span>${task.completed_sprints}/${task.est_sprints} sprints</span>
            </div>
          </div>
        </div>
        <div class="task-row-actions">
          ${task.status === 'todo' ? `<button type="button" class="btn-ghost btn-sm" data-task-focus="${task.id}" title="Lock into Focus Gate">Focus &#9654;</button>` : ''}
          <button type="button" class="btn-danger-ghost btn-sm" data-task-delete="${task.id}" title="Delete task">&times;</button>
        </div>
      </div>
    `;
  }

  function renderTasks() {
    const top3El = $('task-top3-list');
    const backlogEl = $('task-backlog-list');
    const counterEl = $('top3-counter-pill');
    if (!top3El || !backlogEl) return;

    const activeTop3Count = state.tasks.filter((t) => t.is_top3 && t.status === 'todo').length;
    if (counterEl) counterEl.textContent = `${activeTop3Count} / 3 TOP-3`;

    const visible = state.taskTagFilter === 'all'
      ? state.tasks
      : state.tasks.filter((t) => t.tag === state.taskTagFilter);

    const top3Tasks = visible.filter((t) => t.is_top3 && t.status === 'todo');
    const backlogTasks = visible.filter((t) => !(t.is_top3 && t.status === 'todo'));

    top3El.innerHTML = top3Tasks.length
      ? top3Tasks.map(renderTaskRow).join('')
      : `<div class="empty-notes-state">Star up to 3 active tasks to pin Today's Top 3.</div>`;

    backlogEl.innerHTML = backlogTasks.length
      ? backlogTasks.map(renderTaskRow).join('')
      : `<div class="empty-notes-state">No backlog tasks for this filter.</div>`;
  }

  async function focusTaskById(taskId) {
    const task = state.tasks.find((t) => t.id === Number(taskId));
    if (!task) return;

    switchView('focus');
    state.activeTaskId = task.id;
    $('intention-input').value = task.title;
    $('barrier-confirm').checked = true;

    try {
      await enterMicroGate(task.title, state.selectedMinutes, $('strict-mode-toggle').checked, task.id);
    } catch (err) {
      showToast(err.message);
    }
  }

  // --- Collapsible Spotify Focus Drawer ---
  function extractSpotifyEmbedPath(raw) {
    const clean = String(raw || '').trim();
    if (!clean) return null;
    if (/^(playlist|album|track|episode|show)\/[A-Za-z0-9]+$/.test(clean)) return clean;

    try {
      const url = new URL(clean.startsWith('http') ? clean : `https://${clean}`);
      if (!url.hostname.includes('spotify.com')) return null;
      const parts = url.pathname.split('/').filter(Boolean);
      const embedIdx = parts[0] === 'embed' ? 1 : 0;
      const type = parts[embedIdx];
      const id = parts[embedIdx + 1];
      if (['playlist', 'album', 'track', 'episode', 'show'].includes(type) && /^[A-Za-z0-9]+$/.test(id || '')) {
        return `${type}/${id}`;
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  function toggleSpotifyDrawer(forceOpen = null) {
    const drawer = $('spotify-drawer');
    const btn = $('open-spotify-drawer');
    if (!drawer) return;
    const shouldOpen = forceOpen !== null ? forceOpen : drawer.classList.contains('is-hidden');
    drawer.classList.toggle('is-hidden', !shouldOpen);
    if (btn) btn.classList.toggle('is-active', shouldOpen);
  }

  function loadSpotifyEmbed(rawUrlOrPath) {
    const embedPath = extractSpotifyEmbedPath(rawUrlOrPath);
    if (!embedPath) {
      showToast('Paste a valid Spotify playlist, album, or track URL.');
      return;
    }
    const iframe = $('spotify-iframe');
    iframe.src = `https://open.spotify.com/embed/${embedPath}?utm_source=generator&theme=0`;
    iframe.classList.remove('is-hidden');
    toggleSpotifyDrawer(true);
    showToast('Spotify Focus embed loaded.');
  }

  // --- Anti-Doomscroll Urge Shield (with 3-Mode Diversion) ---
  const STROOP_ITEMS = [
    { name: 'MINT', hex: '#5eead4' },
    { name: 'AMBER', hex: '#f59e0b' },
    { name: 'CYAN', hex: '#38bdf8' },
    { name: 'ROSE', hex: '#f43f5e' }
  ];

  function setUrgeDiversionMode(mode) {
    state.urgeDiversionMode = mode;
    document.querySelectorAll('[data-urge-mode]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.urgeMode === mode);
    });
    ['breath', 'stroop', 'reset'].forEach((m) => {
      const panel = $(`urge-panel-${m}`);
      if (panel) panel.classList.toggle('is-hidden', m !== mode);
    });
    if (mode === 'stroop') nextStroopTrial();
    renderUrgeTick();
  }

  function nextStroopTrial() {
    const wordPick = STROOP_ITEMS[Math.floor(Math.random() * STROOP_ITEMS.length)];
    const inkChoices = STROOP_ITEMS.filter((c) => c.name !== wordPick.name);
    const inkPick = inkChoices[Math.floor(Math.random() * inkChoices.length)];
    state.stroopAnswer = inkPick.name;

    const wordEl = $('stroop-word');
    if (wordEl) {
      wordEl.textContent = wordPick.name;
      wordEl.style.color = inkPick.hex;
    }
    const optsEl = $('stroop-options');
    if (optsEl) {
      optsEl.innerHTML = STROOP_ITEMS.map(
        (c) => `<button type="button" class="stroop-btn" data-stroop-pick="${c.name}" style="border-bottom: 2px solid ${c.hex};">${c.name}</button>`
      ).join('');
    }
    if ($('stroop-score-label')) {
      $('stroop-score-label').textContent = `STREAK: ${state.stroopStreak} · HITS: ${state.stroopHits}`;
    }
  }

  function clearUrgeTimer() {
    if (state.urgeInterval) {
      clearInterval(state.urgeInterval);
      state.urgeInterval = null;
    }
  }

  function renderUrgeTick() {
    const rem = state.urgeRemainingSec;
    const elapsed = URGE_COOLDOWN_SECONDS - rem;
    $('urge-timer-display').textContent = `${rem}s`;

    const ring = $('urge-halo-circle');
    if (ring) {
      ring.style.strokeDasharray = `${URGE_HALO_CIRCUMFERENCE}`;
      ring.style.strokeDashoffset = `${URGE_HALO_CIRCUMFERENCE * (1 - rem / URGE_COOLDOWN_SECONDS)}`;
    }

    // Mode A: 4-7-8 Breathing Orb animation (0-4s inhale, 4-11s hold, 11-15s slow exhale)
    const orb = $('breath-orb-circle');
    const cue = $('breath-phase-cue');
    if (orb && cue) {
      if (elapsed < 4) {
        orb.style.transform = 'scale(1.38)';
        cue.textContent = `INHALE SLOWLY · ${4 - elapsed}s`;
      } else if (elapsed < 11) {
        orb.style.transform = 'scale(1.38)';
        cue.textContent = `HOLD STEADY · ${11 - elapsed}s`;
      } else if (rem > 0) {
        orb.style.transform = 'scale(0.75)';
        cue.textContent = `EXHALE & RELEASE · ${rem}s`;
      } else {
        orb.style.transform = 'scale(1.0)';
        cue.textContent = 'BREATH CYCLE COMPLETE';
      }
    }

    // Mode C: 20-20-20 Eye & Posture Reset step highlight
    const stepIdx = elapsed < 5 ? 0 : elapsed < 10 ? 1 : 2;
    document.querySelectorAll('[data-reset-step]').forEach((el) => {
      el.classList.toggle('is-active', Number(el.dataset.resetStep) === stepIdx);
    });

    const ready = rem <= 0;
    $('urge-state-label').textContent = ready ? 'CLARITY RESTORED' : 'COOLING DOWN';
    $('urge-resist-btn').disabled = !ready;
    $('urge-pivot-btn').disabled = !ready;
    $('urge-pivot-btn').textContent = ready
      ? 'Pivot to 2m Micro-Gate'
      : `Pivot to 2m Micro-Gate (${rem}s)`;
  }

  function openUrgeShield() {
    clearUrgeTimer();
    state.urgeRemainingSec = URGE_COOLDOWN_SECONDS;
    state.stroopStreak = 0;
    state.stroopHits = 0;
    $('urge-pivot-intention').value = '';
    $('urge-backdrop').classList.remove('is-hidden');
    setUrgeDiversionMode(state.urgeDiversionMode || 'breath');

    state.urgeInterval = setInterval(() => {
      state.urgeRemainingSec = Math.max(0, state.urgeRemainingSec - 1);
      renderUrgeTick();
      if (state.urgeRemainingSec <= 0) {
        clearUrgeTimer();
      }
    }, 1000);
  }

  function closeUrgeShield() {
    clearUrgeTimer();
    $('urge-backdrop').classList.add('is-hidden');
  }

  async function logUrgeAndExit(outcome) {
    const triggerSource = $('urge-source-input').value.trim() || 'Impulse Feed';
    const pivotIntention = $('urge-pivot-intention').value.trim();
    const elapsedCooldown = URGE_COOLDOWN_SECONDS - state.urgeRemainingSec;

    try {
      await api('/api/urges', {
        method: 'POST',
        body: JSON.stringify({
          trigger_source: triggerSource,
          outcome,
          cooldown_sec: elapsedCooldown,
          note: pivotIntention
        })
      });
    } catch (err) {
      showToast(`Urge log failed: ${err.message}`);
    }

    closeUrgeShield();
    loadTelemetryAndVault();

    if (outcome === 'pivoted') {
      switchView('focus');
      if (pivotIntention) {
        $('intention-input').value = pivotIntention;
        $('barrier-confirm').checked = true;
        try {
          await enterMicroGate(pivotIntention, state.selectedMinutes);
          return;
        } catch (err) {
          showToast(err.message);
        }
      } else {
        showFocusStage('gate');
        $('intention-input').focus();
      }
      showToast('Pivoted into Focus Gate.');
    } else if (outcome === 'resisted') {
      showToast('Urge resisted and logged to Telemetry.');
    } else {
      showToast('Impulse yield logged honestly.');
    }
  }

  // --- Health Probe ---
  async function checkHealth() {
    try {
      const h = await api('/api/health');
      $('db-status-dot').classList.toggle('is-offline', !h.ok);
    } catch (_) {
      $('db-status-dot').classList.add('is-offline');
    }
  }

  // --- Event Wiring ---
  function bindEvents() {
    // View switching
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    // Audio toggles, compact topbar select/mute & synced 0-100% volume sliders
    document.querySelectorAll('[data-audio]').forEach((btn) => {
      btn.addEventListener('click', () => audioEngine.setMode(btn.dataset.audio));
    });
    $('topbar-audio-select').addEventListener('change', (e) => {
      audioEngine.setMode(e.target.value);
    });
    $('topbar-audio-mute').addEventListener('click', () => {
      if (state.audioMode === 'off') {
        audioEngine.setMode(state.lastActiveAudioMode || 'rain');
      } else {
        audioEngine.setMode('off');
      }
    });
    $('topbar-audio-volume').addEventListener('input', (e) => {
      audioEngine.setVolumePct(Number(e.target.value));
    });
    $('noise-volume').addEventListener('input', (e) => {
      audioEngine.setVolumePct(Number(e.target.value));
    });

    // View 1: Gate form
    document.querySelectorAll('.duration-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.selectedMinutes = Number(btn.dataset.minutes);
        document.querySelectorAll('.duration-pill').forEach((p) => p.classList.toggle('is-selected', p === btn));
      });
    });

    $('gate-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const intention = $('intention-input').value.trim();
      if (!intention) {
        $('gate-error').textContent = 'State your objective first.';
        return;
      }
      if (!$('barrier-confirm').checked) {
        $('gate-error').textContent = 'Confirm the anti-doomscroll barrier checkbox.';
        return;
      }
      $('gate-error').textContent = '';
      try {
        await enterMicroGate(intention, state.selectedMinutes, $('strict-mode-toggle').checked);
      } catch (err) {
        $('gate-error').textContent = err.message;
      }
    });

    // View 1: Micro-gate controls
    $('escalate-sprint-btn').addEventListener('click', () => enterDeepSprint());
    $('micro-pause-btn').addEventListener('click', () => {
      state.timerPaused = !state.timerPaused;
      $('micro-pause-btn').textContent = state.timerPaused ? 'Resume' : 'Pause';
    });
    $('micro-abort-btn').addEventListener('click', () => finishSprint('abandoned'));

    // View 1: Deep sprint controls
    $('sprint-pause-btn').addEventListener('click', () => {
      state.timerPaused = !state.timerPaused;
      $('sprint-pause-btn').textContent = state.timerPaused ? 'Resume' : 'Pause';
    });
    $('sprint-complete-btn').addEventListener('click', () => {
      const pctElapsed = state.sprintTotalSec > 0
        ? Math.round((state.sprintElapsedSec / state.sprintTotalSec) * 100)
        : 100;
      if (state.sprintElapsedSec < state.sprintTotalSec * 0.8) {
        const actualMin = computeActualMinutes();
        $('early-complete-msg').textContent =
          `Only ${pctElapsed}% of your target sprint elapsed (${actualMin}m / ${state.selectedMinutes}m). Log as an honest early exit to keep Completion Rate accurate?`;
        $('early-complete-confirm').classList.remove('is-hidden');
        return;
      }
      finishSprint('completed');
    });
    $('early-log-abandoned-btn').addEventListener('click', () => finishSprint('abandoned'));
    $('early-mark-completed-btn').addEventListener('click', () => finishSprint('completed'));
    $('early-resume-btn').addEventListener('click', () => {
      $('early-complete-confirm').classList.add('is-hidden');
    });
    $('sprint-abort-btn').addEventListener('click', () => finishSprint('abandoned'));

    // View 1: Reflection
    $('reflection-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const reflection = $('reflection-input').value.trim();
      if (state.currentSession && reflection) {
        try {
          await api(`/api/sessions/${state.currentSession.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ reflection })
          });
          showToast('Reflection archived to SQLite vault.');
        } catch (err) {
          showToast(err.message);
          return;
        }
      }
      resetGate();
      loadTelemetryAndVault();
    });
    $('reflection-skip-btn').addEventListener('click', () => resetGate());

    // Ambient Canvas Visuals
    document.querySelectorAll('[data-canvas-theme]').forEach((btn) => {
      btn.addEventListener('click', () => ambientCanvas.setTheme(btn.dataset.canvasTheme));
    });
    window.addEventListener('resize', () => {
      if (state.canvasTheme !== 'off') ambientCanvas.resize();
    });

    // View 2: FocusTube Loader, Quick-Topic Launcher & Persistent Study Queue
    $('topic-search-input').addEventListener('input', (e) => {
      renderTopicLauncher(e.target.value);
    });
    $('topic-search-btn').addEventListener('click', () => {
      const q = $('topic-search-input').value.trim();
      const maybeId = extractYouTubeId(q);
      if (maybeId) {
        loadFocusTubeStream(q, '');
      } else {
        renderTopicLauncher(q);
      }
    });
    $('yt-load-form').addEventListener('submit', (e) => {
      e.preventDefault();
      loadFocusTubeStream($('yt-url-input').value, $('yt-title-input').value);
    });
    $('yt-queue-add-btn').addEventListener('click', addCurrentInputToQueue);
    $('queue-next-btn').addEventListener('click', () => {
      const nextItem = state.studyQueue.find((q) => !q.completed);
      if (!nextItem) {
        showToast('No unfinished streams in queue.');
        return;
      }
      loadFocusTubeStream(nextItem.video_id, nextItem.video_title, nextItem.author_name || '');
    });
    $('load-demo-stream-btn').addEventListener('click', () => {
      loadFocusTubeStream('https://www.youtube.com/watch?v=c85dS_3P42U', 'Deep Work & Cognitive Architecture Lecture');
    });

    // Study Clock controls
    $('clock-toggle-btn').addEventListener('click', () => {
      if (state.studyClockRunning) pauseStudyClock();
      else startStudyClock();
    });
    $('clock-back-btn').addEventListener('click', () => seekStreamTo(state.studyClockSec - 15));
    $('clock-fwd-btn').addEventListener('click', () => seekStreamTo(state.studyClockSec + 15));
    $('clock-set-btn').addEventListener('click', () => {
      const parsed = parseTimestampInput($('clock-manual-input').value);
      if (parsed === null) {
        showToast('Use MM:SS or seconds (e.g., 04:20)');
        return;
      }
      seekStreamTo(parsed);
      $('clock-manual-input').value = '';
    });

    // Auto-lock timestamp while typing in Markdown note input
    $('note-input').addEventListener('input', () => {
      const hasText = $('note-input').value.trim().length > 0;
      if ($('lock-ts-checkbox').checked && hasText && state.lockedTimestampSec === null) {
        state.lockedTimestampSec = state.studyClockSec;
        $('note-active-ts').textContent = `@ ${formatSec(state.lockedTimestampSec)} (LOCKED)`;
      } else if (!hasText) {
        state.lockedTimestampSec = null;
        syncStudyClockUI();
      }
    });

    $('note-input').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        $('note-form').requestSubmit();
      }
    });

    $('note-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('note-error').textContent = '';
      if (!state.videoId) {
        $('note-error').textContent = 'Load a YouTube stream first.';
        return;
      }
      const noteText = $('note-input').value.trim();
      if (!noteText) {
        $('note-error').textContent = 'Note text cannot be empty.';
        return;
      }
      const ts = state.lockedTimestampSec !== null ? state.lockedTimestampSec : state.studyClockSec;
      try {
        await api('/api/notes', {
          method: 'POST',
          body: JSON.stringify({
            video_id: state.videoId,
            video_title: state.videoTitle,
            timestamp_sec: ts,
            note_text: noteText
          })
        });
        $('note-input').value = '';
        state.lockedTimestampSec = null;
        syncStudyClockUI();
        await refreshVideoNotes();
        loadTelemetryAndVault();
        showToast(`Note anchored @ ${formatSec(ts)}`);
      } catch (err) {
        $('note-error').textContent = err.message;
      }
    });

    $('export-video-notes-btn').addEventListener('click', () => {
      if (!state.videoId || !state.notesForVideo.length) {
        showToast('No notes to export for current stream.');
        return;
      }
      const md = formatNotesAsMarkdown(state.videoTitle, state.videoId, state.notesForVideo);
      downloadMarkdownFile(`doshe-${state.videoId}.md`, md);
    });

    // AI Study Coach
    document.querySelectorAll('[data-coach-mode]').forEach((btn) => {
      btn.addEventListener('click', () => runCoach(btn.dataset.coachMode));
    });

    // Delegated click handlers (timestamp jump, quiz answer, open stream)
    document.addEventListener('click', (e) => {
      const seekBtn = e.target.closest('[data-seek-sec]');
      if (seekBtn) {
        seekStreamTo(Number(seekBtn.dataset.seekSec));
        return;
      }

      const quizBtn = e.target.closest('.quiz-opt-btn');
      if (quizBtn) {
        const qId = quizBtn.dataset.quizId;
        const picked = Number(quizBtn.dataset.optIdx);
        const answer = Number(quizBtn.dataset.answerIdx);
        const card = $(`quiz-card-${qId}`);
        if (!card) return;
        card.querySelectorAll('.quiz-opt-btn').forEach((b, idx) => {
          b.disabled = true;
          if (idx === answer) b.classList.add('is-correct');
          else if (idx === picked) b.classList.add('is-wrong');
        });
        const exp = $(`quiz-exp-${qId}`);
        if (exp) exp.classList.remove('is-hidden');
        return;
      }

      const openVid = e.target.closest('[data-open-video]');
      if (openVid) {
        switchView('focustube');
        loadFocusTubeStream(
          openVid.dataset.openVideo,
          openVid.dataset.openTitle || '',
          openVid.dataset.openAuthor || ''
        );
        return;
      }

      const delQueueBtn = e.target.closest('[data-queue-delete]');
      if (delQueueBtn) {
        const qId = delQueueBtn.dataset.queueDelete;
        api(`/api/queue/${qId}`, { method: 'DELETE' })
          .then(() => refreshStudyQueue())
          .catch((err) => showToast(err.message));
        return;
      }

      const delNoteBtn = e.target.closest('[data-note-delete]');
      if (delNoteBtn) {
        const nId = delNoteBtn.dataset.noteDelete;
        api(`/api/notes/${nId}`, { method: 'DELETE' })
          .then(async () => {
            if (state.videoId) await refreshVideoNotes();
            await loadTelemetryAndVault();
            showToast('Note deleted.');
          })
          .catch((err) => showToast(err.message));
        return;
      }

      const queuePreset = e.target.closest('[data-queue-preset]');
      if (queuePreset) {
        api('/api/queue', {
          method: 'POST',
          body: JSON.stringify({
            video_id: queuePreset.dataset.queuePreset,
            video_title: queuePreset.dataset.queueTitle || '',
            author_name: queuePreset.dataset.queueAuthor || ''
          })
        })
          .then(() => {
            refreshStudyQueue();
            showToast(`Queued: ${queuePreset.dataset.queueTitle || queuePreset.dataset.queuePreset}`);
          })
          .catch((err) => showToast(err.message));
        return;
      }

      const exportVid = e.target.closest('[data-export-video]');
      if (exportVid) {
        const vid = exportVid.dataset.exportVideo;
        const notes = state.allNotes.filter((n) => n.video_id === vid).sort((a, b) => a.timestamp_sec - b.timestamp_sec);
        if (notes.length) {
          downloadMarkdownFile(`doshe-${vid}.md`, formatNotesAsMarkdown(notes[0].video_title, vid, notes));
        }
      }
    });

    // Listen to YouTube postMessage time sync when available
    window.addEventListener('message', (event) => {
      if (!String(event.origin).includes('youtube')) return;
      try {
        const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (msg && msg.info && typeof msg.info.currentTime === 'number') {
          state.studyClockSec = Math.floor(msg.info.currentTime);
          syncStudyClockUI();
        }
      } catch (_) {
        // ignore non-JSON postMessages
      }
    });

    // Telemetry filters & export
    document.querySelectorAll('[data-session-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.sessionFilter = btn.dataset.sessionFilter;
        document.querySelectorAll('[data-session-filter]').forEach((b) => b.classList.toggle('is-active', b === btn));
        renderSessionsList();
      });
    });
    $('export-all-notes-btn').addEventListener('click', exportAllNotesMarkdown);

    // Study queue completion checkbox delegation
    $('study-queue-list').addEventListener('change', (e) => {
      const cb = e.target.closest('[data-queue-toggle]');
      if (!cb) return;
      const qId = cb.dataset.queueToggle;
      api(`/api/queue/${qId}`, {
        method: 'PATCH',
        body: JSON.stringify({ completed: cb.checked })
      })
        .then(() => refreshStudyQueue())
        .catch((err) => showToast(err.message));
    });

    // Tab-Switch, Window Blur & Strict Breach Telemetry across BOTH 2m Micro-Gate & Deep Focus Sprint
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        handleFocusLoss('Off-Tab Switch');
      }
    });

    window.addEventListener('blur', () => {
      if (document.activeElement && document.activeElement.tagName === 'IFRAME') return;
      handleFocusLoss('Window Switch');
    });

    window.addEventListener('pagehide', () => {
      syncSessionTelemetryNow(true);
    });

    document.addEventListener('fullscreenchange', () => {
      if (
        !document.fullscreenElement &&
        !state.exitingFullscreenCleanly &&
        state.strictMode &&
        !state.timerPaused &&
        (state.focusStage === 'micro' || state.focusStage === 'sprint')
      ) {
        recordStrictBreach('Fullscreen Exit');
        syncSessionTelemetryNow(false);
      }
    });

    // Spotify Focus Drawer
    $('open-spotify-drawer').addEventListener('click', () => toggleSpotifyDrawer());
    $('close-spotify-drawer').addEventListener('click', () => toggleSpotifyDrawer(false));
    $('spotify-form').addEventListener('submit', (e) => {
      e.preventDefault();
      loadSpotifyEmbed($('spotify-url-input').value);
    });
    document.querySelectorAll('[data-spotify-preset]').forEach((btn) => {
      btn.addEventListener('click', () => loadSpotifyEmbed(btn.dataset.spotifyPreset));
    });

    // Task Backlog & Daily Top-3
    $('task-add-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = $('task-title-input').value.trim();
      if (!title) {
        showToast('Enter a task title first.');
        return;
      }
      const parsedEst = Math.min(20, Math.max(1, Number.parseInt($('task-est-input').value, 10) || 1));
      try {
        await api('/api/tasks', {
          method: 'POST',
          body: JSON.stringify({
            title,
            tag: $('task-tag-select').value || 'Study',
            priority: 'medium',
            est_sprints: parsedEst,
            is_top3: false
          })
        });
        $('task-title-input').value = '';
        $('task-est-input').value = '1';
        await refreshTasks();
        showToast('Task added to backlog.');
      } catch (err) {
        showToast(err.message);
      }
    });

    document.querySelectorAll('[data-task-tag-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.taskTagFilter = btn.dataset.taskTagFilter;
        document.querySelectorAll('[data-task-tag-filter]').forEach((b) => b.classList.toggle('is-active', b === btn));
        renderTasks();
      });
    });

    $('task-backlog-card').addEventListener('change', (e) => {
      const cb = e.target.closest('[data-task-toggle]');
      if (!cb) return;
      api(`/api/tasks/${cb.dataset.taskToggle}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: cb.checked ? 'done' : 'todo' })
      })
        .then(() => refreshTasks())
        .catch((err) => showToast(err.message));
    });

    $('task-backlog-card').addEventListener('click', (e) => {
      const starBtn = e.target.closest('[data-task-top3]');
      if (starBtn) {
        const id = Number(starBtn.dataset.taskTop3);
        const task = state.tasks.find((t) => t.id === id);
        if (!task) return;
        api(`/api/tasks/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ is_top3: !task.is_top3 })
        })
          .then(() => refreshTasks())
          .catch((err) => showToast(err.message));
        return;
      }

      const focusBtn = e.target.closest('[data-task-focus]');
      if (focusBtn) {
        focusTaskById(focusBtn.dataset.taskFocus);
        return;
      }

      const delBtn = e.target.closest('[data-task-delete]');
      if (delBtn) {
        api(`/api/tasks/${delBtn.dataset.taskDelete}`, { method: 'DELETE' })
          .then(() => refreshTasks())
          .catch((err) => showToast(err.message));
      }
    });

    // Urge Shield modal & 3-mode diversion events
    $('open-urge-shield').addEventListener('click', openUrgeShield);
    $('urge-close-btn').addEventListener('click', closeUrgeShield);
    $('urge-backdrop').addEventListener('click', (e) => {
      if (e.target === $('urge-backdrop')) closeUrgeShield();
    });
    document.querySelectorAll('[data-urge-mode]').forEach((btn) => {
      btn.addEventListener('click', () => setUrgeDiversionMode(btn.dataset.urgeMode));
    });
    $('stroop-options').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-stroop-pick]');
      if (!btn) return;
      if (btn.dataset.stroopPick === state.stroopAnswer) {
        state.stroopStreak += 1;
        state.stroopHits += 1;
      } else {
        state.stroopStreak = 0;
      }
      nextStroopTrial();
    });
    document.querySelectorAll('[data-urge-source]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-urge-source]').forEach((b) => b.classList.toggle('is-active', b === btn));
        $('urge-source-input').value = btn.dataset.urgeSource;
      });
    });
    $('urge-resist-btn').addEventListener('click', () => logUrgeAndExit('resisted'));
    $('urge-pivot-btn').addEventListener('click', () => logUrgeAndExit('pivoted'));
    $('urge-yield-btn').addEventListener('click', () => logUrgeAndExit('yielded'));

    // Command Palette
    $('open-cmd-palette').addEventListener('click', openCommandPalette);
    $('cmd-backdrop').addEventListener('click', (e) => {
      if (e.target === $('cmd-backdrop')) closeCommandPalette();
    });
    $('cmd-search-input').addEventListener('input', () => {
      state.cmdSelectedIndex = 0;
      renderCommandPaletteResults();
    });
    $('cmd-search-input').addEventListener('keydown', (e) => {
      const items = getPaletteCommands($('cmd-search-input').value);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        state.cmdSelectedIndex = (state.cmdSelectedIndex + 1) % Math.max(1, items.length);
        renderCommandPaletteResults();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        state.cmdSelectedIndex = (state.cmdSelectedIndex - 1 + Math.max(1, items.length)) % Math.max(1, items.length);
        renderCommandPaletteResults();
      } else if (e.key === 'Enter' && items[state.cmdSelectedIndex]) {
        e.preventDefault();
        const chosen = items[state.cmdSelectedIndex];
        closeCommandPalette();
        chosen.run();
      } else if (e.key === 'Escape') {
        closeCommandPalette();
      }
    });
    $('cmd-results').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cmd-idx]');
      if (!btn) return;
      const items = getPaletteCommands($('cmd-search-input').value);
      const chosen = items[Number(btn.dataset.cmdIdx)];
      if (chosen) {
        closeCommandPalette();
        chosen.run();
      }
    });

    // Global Ctrl+K / Cmd+K shortcut
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if ($('cmd-backdrop').classList.contains('is-hidden')) {
          openCommandPalette();
        } else {
          closeCommandPalette();
        }
      } else if (e.key === 'Escape' && !$('cmd-backdrop').classList.contains('is-hidden')) {
        closeCommandPalette();
      } else if (e.key === 'Escape' && !$('urge-backdrop').classList.contains('is-hidden')) {
        closeUrgeShield();
      }
    });
  }

  // --- Bootstrap ---
  bindEvents();
  updateHalo('micro-halo-circle', 1);
  updateHalo('sprint-halo-circle', 1);
  renderTopicLauncher();
  checkHealth();
  loadTelemetryAndVault();
  refreshStudyQueue();
  refreshTasks();
})();
