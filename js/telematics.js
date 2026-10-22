// The cellular path, phone -> cloud -> gateway: the owner's token is
// forwarded, an attacker's guess is blocked while auth is on.
(function (SIM) {
  'use strict';

  function Telematics(gateway) {
    this.gw = gateway;
    this.ownerToken = gateway.sessionKey;
    this.latency = 350;                     // ms of pretend cellular round-trip
  }

  Telematics.prototype._send = function (who, kind, payload, token) {
    SIM.emit('tel', who + ' → cloud: ' + kind + ' request…');
    setTimeout(() => {
      SIM.emit('tel', 'cloud → car: relaying ' + kind);
      this.gw.request(kind, payload, token);
    }, this.latency);
  };

  Telematics.prototype.ownerRemoteStart = function () { this._send('Owner app', 'start', null, this.ownerToken); };
  Telematics.prototype.ownerUnlock      = function () { this._send('Owner app', 'unlock', null, this.ownerToken); };
  Telematics.prototype.ownerLock        = function () { this._send('Owner app', 'lock',  null, this.ownerToken); };

  // Found the API but not the key.
  Telematics.prototype.attackerRemoteStart = function () { this._send('Attacker', 'start', null, 0x00); };
  Telematics.prototype.attackerUnlock      = function () { this._send('Attacker', 'unlock', null, 0x00); };

  SIM.Telematics = Telematics;
})(globalThis.SIM = globalThis.SIM || {});
