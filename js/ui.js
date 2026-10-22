(function (SIM) {
  'use strict';
  const $ = function (id) { return document.getElementById(id); };
  const hex = function (b) { return ('0' + b.toString(16)).slice(-2); };
  const bytesHex = function (arr) { return Array.prototype.map.call(arr, hex).join(' '); };

  const UI = {};
  let lastRefresh = 0;

  UI.init = function () {
    const canvas = $('view');
    SIM.build(canvas);

    const a = SIM.api;
    $('fobUnlock').onclick = a.fobUnlock;
    $('fobLock').onclick   = a.fobLock;
    $('replay').onclick    = a.replay;
    $('relay').onclick     = a.relay;
    $('jammer').onchange   = function (e) { a.jammer(e.target.checked); };
    $('db').onchange       = function (e) { a.setDB(e.target.checked); };
    $('tau').oninput       = function (e) {
      const ns = parseInt(e.target.value, 10);
      a.setTau(ns);
      $('tauval').textContent = ns;
      $('taudist').textContent = (SIM.DistanceBounding.maxRelayDistanceM(ns)).toFixed(1);
    };

    $('telStart').onclick  = a.telStart;
    $('telUnlock').onclick = a.telUnlock;
    $('attackTel').onclick = a.attackTel;

    $('startEng').onclick  = a.startEngine;
    $('stopEng').onclick   = a.stopEngine;
    $('reset').onclick     = a.resetPose;

    document.querySelectorAll('[data-gear]').forEach(function (btn) {
      btn.onclick = function () {
        a.setGear(parseInt(btn.dataset.gear, 10));
        document.querySelectorAll('[data-gear]').forEach(function (b) { b.classList.remove('on'); });
        btn.classList.add('on');
      };
    });

    $('auth').onchange   = function (e) { a.setAuth(e.target.checked); };
    $('secoc').onchange  = function (e) { a.setSecoc(e.target.checked); };
    $('inject').onchange = function (e) { a.setInject(e.target.checked); };
    $('follow').onchange = function (e) { a.follow(e.target.checked); };
  };

  UI.refresh = function (B) {
    const now = performance.now();
    if (now - lastRefresh < 90) return;   // ~11 Hz is plenty for text
    lastRefresh = now;

    const v = B.veh;
    $('spd').textContent = Math.abs(v.speed).toFixed(0);
    $('rpm').textContent = B.ecm.rpm.toFixed(0);
    $('gear').textContent = v.gearName();
    $('eng').textContent = SIM.CAN.ENGINE[B.ecm.state];
    $('eng').className = 'val ' + (B.ecm.state === 2 ? 'good' : B.ecm.state === 1 ? 'warn' : 'bad');
    $('door').textContent = v.doorsLocked ? 'LOCKED' : 'UNLOCKED';
    $('door').className = 'val ' + (v.doorsLocked ? 'bad' : 'good');
    $('str').textContent = v.steerAngle.toFixed(0) + '°';

    const latest = {};
    const log = B.bus.log;
    for (let i = 0; i < log.length; i++) latest[log[i].id] = log[i];
    let rows = '';
    Object.keys(SIM.CAN.DB).forEach(function (name) {
      const id = SIM.CAN.DB[name].id;
      const e = latest[id];
      if (!e) return;
      let sig = '';
      if (e.decoded) Object.keys(e.decoded).forEach(function (k) {
        if (k[0] === '_') return;
        let val = e.decoded[k];
        if (typeof val === 'number') val = Math.round(val * 100) / 100;
        sig += '<span class="sig">' + k + '=' + val + '</span> ';
      });
      const bad = e.decoded && e.decoded._checksum_ok === false;
      rows += '<tr class="' + (bad ? 'crc' : '') + '"><td class="cid">0x' + e.id.toString(16).toUpperCase() +
              '</td><td class="cnm">' + name + '</td><td class="cby">' + bytesHex(e.data) +
              '</td><td class="csg">' + sig + (e.src ? '<span class="src">@' + e.src + '</span>' : '') + '</td></tr>';
    });
    $('canbody').innerHTML = rows;

    let raw = '';
    for (let i = Math.max(0, log.length - 10); i < log.length; i++) {
      const e = log[i];
      raw += '0x' + e.id.toString(16).toUpperCase().padStart(3, '0') + '  ' + bytesHex(e.data) +
             (e.src ? '  @' + e.src : '') + '\n';
    }
    $('rawlog').textContent = raw;

    let ev = '';
    const events = SIM.events;
    for (let i = Math.max(0, events.length - 9); i < events.length; i++) {
      ev += '<div class="ev ' + events[i].chan + '">[' + events[i].chan + '] ' + events[i].msg + '</div>';
    }
    $('evlog').innerHTML = ev;
  };

  SIM.UI = UI;
  window.addEventListener('DOMContentLoaded', UI.init);
})(window.SIM = window.SIM || {});
