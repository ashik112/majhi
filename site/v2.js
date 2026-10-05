// Live panels for the sections after the hero. Plain JS, no libraries.
// Every panel is complete in its own markup (the final state). A panel that scrolls into view resets itself, plays
// a short script, loops calmly and stops when it leaves the screen. With reduced motion nothing plays.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  class Stop extends Error {}
  const wait = (tok, ms) => new Promise((res, rej) => setTimeout(() => (tok.stopped ? rej(new Stop()) : res()), ms));

  /** Run a looping script while `el` is on screen. reset() sets the first frame, play(tok) is the script. */
  function live(el, { reset, play, final, gap = 2600 }) {
    final?.();
    if (reduce) return;
    let tok = null;
    const start = async () => {
      if (tok) return;
      const t = (tok = { stopped: false });
      try {
        for (;;) { reset(); await play(t); await wait(t, gap); }
      } catch (e) { if (!(e instanceof Stop)) throw e; }
    };
    const stop = () => { if (tok) { tok.stopped = true; tok = null; } };
    new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop()), { threshold: 0.3 }).observe(el);
    return { start, stop };
  }

  /** Show every [data-step] up to step n, and hide those past their data-until. */
  function setAt(root, n) {
    for (const e of $$("[data-step]", root)) {
      const until = e.dataset.until === undefined ? Infinity : +e.dataset.until;
      e.classList.toggle("on", +e.dataset.step <= n && n < until);
    }
    root.dataset.at = n;
  }
  const mode = (root, on) => root.classList.toggle("live", on);

  async function type(tok, el, text, ms = 32) {
    el.textContent = "";
    for (const ch of text) { el.textContent += ch; await wait(tok, ms); }
  }
  const press = async (tok, btn) => { btn.classList.add("press"); await wait(tok, 240); btn.classList.remove("press"); };

  /** Tween a meter: the bar width and its number. */
  function meter(el, pct, text) {
    el.style.setProperty("--p", pct);
    if (text !== undefined) el.dataset.pct = text;
  }

  // ---------------------------------------------------------------- 1. the live window
  function windowDemo() {
    const root = $("#win"); if (!root) return;
    const list = $("#hl");
    const ORG = { A: ["Acme", "var(--yellow)"], G: ["Globex", "var(--pink)"], N: ["Northwind", "var(--sky)"] };
    const SECS = [["needs", "Needs you"], ["running", "Running now"], ["next", "Up next"], ["done", "Done today"]];
    const ST = {
      need: ["need", "t-need"], work: ["work", "t-work"], idle: ["idle", "t-idle"], done: ["done", "t-done"],
    };
    const DEF = {
      "ACM-9": { o: "A", t: "Reset email links expire too early" },
      "ACM-12": { o: "A", t: "Fix the login bug" },
      "GLB-7": { o: "G", t: "Move invoices to the v2 billing API" },
      "NWN-3": { o: "N", t: "Add CSV export to reports" },
      "GLB-8": { o: "G", t: "Upgrade the mailer package" },
      "NWN-4": { o: "N", t: "Speed up the report page" },
      "ACM-8": { o: "A", t: "Fix the typo on the pricing page" },
    };
    const P = {
      review: { st: "need", chip: "Review", de: "Ready to ship, checks green, 3 files", wt: "12m", btn: "Review" },
      answer: { st: "need", chip: "Answer", de: "@globex-lead asks: use the v2 billing API?", wt: "1m", btn: "Answer" },
      acm12: { st: "work", chip: "Working", de: "@acme-builder is running the tests", wt: "8m" },
      glb7: { st: "work", chip: "Working", de: "@globex-lead is editing 4 files", wt: "21m" },
      nwn3: { st: "work", chip: "Working", de: "@northwind-builder is reading the schema", wt: "4m" },
      glb8w: { st: "work", chip: "Working", de: "@globex-builder just started", wt: "now" },
      glb8: { st: "idle", chip: "Ready", de: "Waits for GLB-7", wt: "", btn: "Start" },
      nwn4: { st: "idle", chip: "Ready", de: "Nobody on it yet", wt: "", btn: "Start" },
      acm8: { st: "done", chip: "Done", de: "Merged into main, 1 file", wt: "2h" },
      acm9d: { st: "done", chip: "Done", de: "Merged into main, 3 files", wt: "now" },
    };
    const rows = {};
    const secEls = {};
    list.innerHTML = SECS.map(([k, l]) => `<div data-sec="${k}"><div class="sh"><b>${l}</b><em></em></div><div class="rows"></div></div>`).join("");
    for (const [k] of SECS) secEls[k] = $(`[data-sec="${k}"]`, list);
    for (const [id, d] of Object.entries(DEF)) {
      const r = document.createElement("div");
      r.className = "hr";
      const [name, col] = ORG[d.o];
      r.innerHTML = `<span class="lamp"></span><span class="chip"></span><span class="id mono">${id}</span><span class="ti">${d.t}</span>` +
        `<span class="org"><span class="ot" style="--oc:${col}">${name[0]}</span><span>${name}</span></span><span class="de"></span><span class="wt mono"></span><span class="ac"></span>`;
      rows[id] = r;
    }
    function setRow(id, p) {
      const r = rows[id], [lamp, tone] = ST[p.st];
      r.querySelector(".lamp").className = `lamp ${lamp}`;
      const chip = r.querySelector(".chip"); chip.textContent = p.chip; chip.className = `chip ${tone}`;
      r.querySelector(".de").textContent = p.de;
      r.querySelector(".wt").textContent = p.wt;
      r.querySelector(".ac").innerHTML = p.btn ? `<span class="abtn">${p.btn}</span>` : "";
    }
    const put = (id, sec, p, top = false) => {
      setRow(id, p);
      const box = secEls[sec].querySelector(".rows");
      top ? box.prepend(rows[id]) : box.append(rows[id]);
    };
    const num = { open: $("#t-open"), work: $("#t-work"), need: $("#t-need"), done: $("#t-done") };
    const last = {};
    function counts(bump) {
      const n = (k) => secEls[k].querySelectorAll(".hr").length;
      for (const [k] of SECS) secEls[k].querySelector("em").textContent = n(k);
      const v = { open: n("needs") + n("running") + n("next"), work: n("running"), need: n("needs"), done: n("done") };
      for (const k of Object.keys(v)) {
        const b = num[k];
        b.textContent = v[k];
        b.classList.toggle("lit", k !== "open" && k !== "done" ? v[k] > 0 : false);
        if (bump && last[k] !== v[k]) { b.classList.remove("bump"); void b.offsetWidth; b.classList.add("bump"); }
        last[k] = v[k];
      }
    }
    function flip(change) {
      const all = Object.values(rows);
      const first = new Map(all.map((r) => [r, r.getBoundingClientRect().top]));
      change();
      counts(true);
      for (const r of all) {
        const dy = first.get(r) - r.getBoundingClientRect().top;
        if (Math.abs(dy) > 1) r.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 560, easing: "cubic-bezier(.2,.8,.2,1)" });
      }
    }
    const flash = (id) => { const r = rows[id]; r.classList.remove("flash"); void r.offsetWidth; r.classList.add("flash"); };
    const initial = () => {
      put("ACM-9", "needs", P.review);
      put("ACM-12", "running", P.acm12); put("GLB-7", "running", P.glb7); put("NWN-3", "running", P.nwn3);
      put("GLB-8", "next", P.glb8); put("NWN-4", "next", P.nwn4);
      put("ACM-8", "done", P.acm8);
      counts(false);
    };
    const end = () => {
      put("GLB-7", "needs", P.answer);
      put("ACM-12", "running", P.acm12); put("NWN-3", "running", P.nwn3); put("GLB-8", "running", P.glb8w);
      put("NWN-4", "next", P.nwn4);
      put("ACM-9", "done", P.acm9d); put("ACM-8", "done", P.acm8);
      counts(false);
    };
    const tg = $("#ap-tg");
    initial(); end(); // the page is complete at rest
    live(root, {
      reset() { tg.classList.add("on"); initial(); },
      async play(tok) {
        await wait(tok, 2400);
        flip(() => put("GLB-7", "needs", P.answer)); flash("GLB-7");
        await wait(tok, 3000);
        await press(tok, rows["ACM-9"].querySelector(".abtn"));
        flip(() => put("ACM-9", "done", P.acm9d, true)); flash("ACM-9");
        await wait(tok, 3000);
        flip(() => put("GLB-8", "running", P.glb8w)); flash("GLB-8");
        await wait(tok, 3600);
      },
      final: () => {},
    });
  }

  // ---------------------------------------------------------------- 2. how it works
  function how() {
    const stage = $("#hw"); if (!stage) return;
    const steps = $$(".hw-step"), panes = $$(".pane", stage);
    let cur = 0;
    const show = (i) => {
      cur = i;
      steps.forEach((s, k) => { s.classList.toggle("on", k === i); s.setAttribute("aria-selected", String(k === i)); });
      panes.forEach((p, k) => p.classList.toggle("on", k === i));
    };
    const typed = (p) => $$("[data-type]", p);
    const fillTyped = (p) => typed(p).forEach((e) => (e.textContent = e.dataset.type));
    const planSync = (p, n) => {
      for (const li of $$("[data-dn]", p)) li.classList.toggle("dn", +li.dataset.dn <= n);
      const c = $("[data-count]", p); if (c) c.textContent = $$("[data-dn].dn", p).length;
    };

    const P0 = panes[0], P1 = panes[1], P2 = panes[2], P3 = panes[3];
    const scripts = [
      { // write
        reset() { mode(P0, true); setAt(P0, 0); typed(P0).forEach((e) => (e.textContent = "")); $("#caret1").style.display = ""; },
        async play(tok) {
          const [a, b] = typed(P0);
          await wait(tok, 500);
          await type(tok, a, a.dataset.type, 34);
          await wait(tok, 350);
          $("#caret1").style.display = "none"; P0.querySelectorAll(".fld")[0].classList.remove("focus"); P0.querySelectorAll(".fld")[1].classList.add("focus");
          await type(tok, b, b.dataset.type, 16);
          P0.querySelectorAll(".fld")[1].classList.remove("focus");
          for (let n = 1; n <= 3; n++) { setAt(P0, n); await wait(tok, 380); }
          await wait(tok, 400);
          await press(tok, $("#create"));
          setAt(P0, 4);
          await wait(tok, 2200);
        },
        final() { mode(P0, true); setAt(P0, 99); fillTyped(P0); $("#caret1").style.display = "none"; },
      },
      { // work
        reset() { mode(P1, true); setAt(P1, 0); planSync(P1, 0); },
        async play(tok) {
          await wait(tok, 700);
          setAt(P1, 1); await wait(tok, 1300);
          setAt(P1, 2); planSync(P1, 1); await wait(tok, 1100);
          setAt(P1, 3); await wait(tok, 1100);
          setAt(P1, 4); await wait(tok, 1500);
          setAt(P1, 5); planSync(P1, 2); await wait(tok, 900);
          setAt(P1, 6); planSync(P1, 3); await wait(tok, 2200);
        },
        final() { mode(P1, true); setAt(P1, 99); planSync(P1, 3); },
      },
      { // check
        reset() { mode(P2, true); setAt(P2, 0); },
        async play(tok) {
          await wait(tok, 500);
          for (let n = 1; n <= 3; n++) { setAt(P2, n); await wait(tok, 650); }
          setAt(P2, 4); await wait(tok, 1000);
          setAt(P2, 5); await wait(tok, 900);
          setAt(P2, 6); await wait(tok, 800);
          setAt(P2, 7); await wait(tok, 1000);
          setAt(P2, 8); await wait(tok, 2200);
        },
        final() { mode(P2, true); setAt(P2, 99); },
      },
      { // ship
        reset() { mode(P3, true); setAt(P3, 0); $$(".menu div", P3).forEach((d) => d.classList.remove("hi")); $("#lamp-ship").className = "lamp need"; $("#ship-st").textContent = "Ready to ship"; $("#ship-btn").innerHTML = 'Ship <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 4l3 3 3-3"/></svg>'; },
        async play(tok) {
          await wait(tok, 800);
          await press(tok, $("#ship-btn"));
          setAt(P3, 2); await wait(tok, 1100);
          $$(".menu div", P3)[1].classList.add("hi"); await wait(tok, 600);
          $$(".menu div", P3)[1].classList.remove("hi"); $$(".menu div", P3)[0].classList.add("hi"); await wait(tok, 1100);
          setAt(P3, 5); $("#ship-btn").innerHTML = '<span class="spin"></span> Merging'; await wait(tok, 900);
          setAt(P3, 6); $("#lamp-ship").className = "lamp done"; $("#ship-st").textContent = "Done"; $("#ship-btn").textContent = "Done";
          await wait(tok, 2800);
        },
        final() { mode(P3, true); setAt(P3, 99); $("#lamp-ship").className = "lamp done"; $("#ship-st").textContent = "Done"; $("#ship-btn").textContent = "Done"; },
      },
    ];
    scripts.forEach((s) => s.final());
    // the final state of the menu is closed
    $$(".menu", P3).forEach((m) => m.classList.remove("on"));
    show(0);
    let tok = null, visible = false;
    const run = (from) => {
      stop();
      const t = (tok = { stopped: false });
      (async () => {
        try {
          let i = from;
          for (;;) {
            show(i); scripts[i].reset();
            await scripts[i].play(t);
            await wait(t, 1400);
            i = (i + 1) % scripts.length;
          }
        } catch (e) { if (!(e instanceof Stop)) throw e; }
      })();
    };
    const stop = () => { if (tok) { tok.stopped = true; tok = null; } };
    steps.forEach((s, i) => s.addEventListener("click", () => {
      show(i);
      if (reduce || !visible) { scripts[i].final(); return; }
      run(i);
    }));
    if (!reduce) {
      new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? run(cur) : stop(); }, { threshold: 0.3 }).observe(stage);
    }
  }

  // ---------------------------------------------------------------- numbers that count up
  function counters() {
    for (const el of $$("[data-to]")) {
      const to = +el.dataset.to;
      if (reduce) { el.textContent = to; continue; }
      new IntersectionObserver(([e], o) => {
        if (!e.isIntersecting) return;
        o.disconnect();
        const t0 = performance.now();
        const tick = (t) => {
          const k = Math.min(1, (t - t0) / 1100);
          el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3)));
          if (k < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }, { threshold: 0.6 }).observe(el);
    }
  }

  // ---------------------------------------------------------------- 3. clients keep apart
  function clients() {
    const root = $("#cl"); if (!root) return;
    const walls = $$(".wall", root), cols = $$(".col", root);
    live(root, {
      reset() { mode(root, true); setAt(root, 0); walls.forEach((w) => w.classList.remove("hit")); cols.forEach((c) => c.classList.remove("glow")); },
      async play(tok) {
        await wait(tok, 900);
        setAt(root, 1); await wait(tok, 1500);
        setAt(root, 2); walls[0].classList.add("hit"); cols[1].classList.add("glow"); await wait(tok, 2200);
        walls[0].classList.remove("hit"); cols[1].classList.remove("glow");
        setAt(root, 3); await wait(tok, 2600);
      },
      final() { setAt(root, 99); },
    });
  }

  // ---------------------------------------------------------------- 4. accounts hand off
  function accounts() {
    const root = $("#acc"); if (!root) return;
    const c1 = $("#c1"), c2 = $("#c2");
    const val = (card, i, pct, text, tone) => {
      const w = $$(".win1", card)[i];
      const b = $("b", w);
      b.textContent = text;
      b.className = `mono ${tone === "amber" ? "am" : tone === "red" ? "rd" : ""}`;
      const bar = $(".bar", w); bar.className = `bar ${tone || ""}`; bar.style.setProperty("--p", pct);
    };
    const status = (card, lamp, cls, text) => {
      $(".ac-h .lamp", card).className = `lamp ${lamp}`;
      const t = $("[data-st]", card); t.className = `tl ${cls}`; t.textContent = text;
    };
    const run = (card, lamp, text) => { const r = $(".runl", card); if (r) { $(".lamp", r).className = `lamp ${lamp}`; $("[data-run]", r).textContent = text; } };
    if (!$(".runl", c2)) c2.insertAdjacentHTML("beforeend", '<div class="runl"><span class="lamp idle"></span><span data-run>Ready for work</span></div>');
    const first = () => {
      c1.classList.remove("lim"); c2.classList.remove("lit");
      val(c1, 0, 82, "82%", "amber"); status(c1, "work", "t-work", "Working"); run(c1, "work", "@acme-builder is working on ACM-12");
      val(c2, 0, 6, "6%", ""); status(c2, "idle", "t-idle", "Ready"); run(c2, "idle", "Ready for work");
    };
    const last = () => {
      c1.classList.add("lim"); c2.classList.add("lit");
      val(c1, 0, 100, "100%", "red"); status(c1, "pause", "t-pause", "At limit"); run(c1, "pause", "Paused until the limit resets");
      val(c2, 0, 11, "11%", ""); status(c2, "work", "t-work", "Working"); run(c2, "work", "@acme-builder continued ACM-12");
    };
    last(); setAt(root, 99);
    live(root, {
      reset() { mode(root, true); setAt(root, 0); first(); },
      async play(tok) {
        await wait(tok, 1400);
        val(c1, 0, 92, "92%", "amber"); await wait(tok, 1000);
        val(c1, 0, 100, "100%", "red"); await wait(tok, 600);
        c1.classList.add("lim"); status(c1, "pause", "t-pause", "At limit"); run(c1, "pause", "Paused until the limit resets");
        await wait(tok, 1000);
        setAt(root, 1); await wait(tok, 900);
        c2.classList.add("lit"); status(c2, "work", "t-work", "Working"); run(c2, "work", "@acme-builder continued ACM-12");
        val(c2, 0, 11, "11%", ""); await wait(tok, 3800);
      },
      final: () => {},
    });
  }

  // ---------------------------------------------------------------- 5. auto-pilot night
  function night() {
    const root = $("#night"); if (!root) return;
    const tg = $("#nt-tg"), bar = $("#nt-bar"), sp = $("#nt-sp");
    const spend = [["0", 0, "$0.00"], ["1", 6, "$1.20"], ["2", 12, "$2.60"], ["3", 17, "$3.40"], ["4", 21, "$4.20"]];
    const money = (k) => { bar.style.setProperty("--p", spend[k][1]); sp.textContent = `${spend[k][2]} of $20`; };
    live(root, {
      reset() { mode(root, true); setAt(root, 0); tg.classList.remove("on"); money(0); },
      async play(tok) {
        await wait(tok, 1000);
        tg.classList.add("on"); await wait(tok, 900);
        for (let n = 1; n <= 4; n++) { setAt(root, n); money(n); await wait(tok, 1500); }
        setAt(root, 5); await wait(tok, 3800);
      },
      final() { setAt(root, 99); tg.classList.add("on"); money(4); },
    });
  }

  // ---------------------------------------------------------------- 6. control
  function control() {
    const root = $("#ctl"); if (!root) return;
    const bar = $("#bud-bar"), n = $("#bud-n");
    const set = (v) => { bar.style.setProperty("--p", v * 5); n.textContent = `$${v.toFixed(2)}`; bar.className = `bar ${v >= 20 ? "red" : v >= 16 ? "amber" : ""}`; };
    live(root, {
      reset() { mode(root, true); setAt(root, 0); set(12); },
      async play(tok) {
        await wait(tok, 1500);
        await press(tok, $("#appr")); setAt(root, 3);
        await wait(tok, 1400);
        for (const v of [14.5, 16.8, 18.9, 20]) { set(v); await wait(tok, 700); }
        setAt(root, 4); await wait(tok, 3600);
      },
      final() { mode(root, true); setAt(root, 99); set(20); },
    });
  }

  // ---------------------------------------------------------------- 7. breaks
  function breaks() {
    const root = $("#rz"); if (!root) return;
    const cards = $$("[data-rc]", root);
    live(root, {
      reset() { cards.forEach((c) => { mode(c, true); setAt(c, 0); }); },
      async play(tok) {
        for (const c of cards) { await wait(tok, 1500); setAt(c, 1); }
        await wait(tok, 3500);
      },
      final() { cards.forEach((c) => setAt(c, 99)); },
    });
  }

  windowDemo();
  how();
  counters();
  clients();
  accounts();
  night();
  control();
  breaks();
})();
