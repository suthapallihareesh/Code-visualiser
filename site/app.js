// Highlights the download card that matches the visitor's operating system.
(function () {
  'use strict';
  var ua = (navigator.userAgent || '').toLowerCase();
  var plat = (navigator.platform || '').toLowerCase();
  var os = null;
  if (/android|iphone|ipad|ipod/.test(ua)) os = null;       // phones cannot run the desktop app
  else if (/win/.test(plat) || /windows/.test(ua)) os = 'windows';
  else if (/mac/.test(plat) || /mac os/.test(ua)) os = 'mac';
  else if (/linux|x11/.test(plat) || /linux/.test(ua)) os = 'linux';

  var names = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };
  var hint = document.getElementById('osHint');
  var primary = document.getElementById('primaryDownload');

  if (os) {
    var card = document.querySelector('.os[data-os="' + os + '"]');
    if (card) card.classList.add('match');
    if (primary) primary.textContent = 'Download for ' + names[os];
    if (hint) hint.textContent = 'Also available for ' + Object.keys(names).filter(function (k) { return k !== os; }).map(function (k) { return names[k]; }).join(' and ');
  } else if (hint) {
    hint.textContent = 'Code Studio is a desktop app for Windows, macOS and Linux. Open this page on your computer to install it.';
  }
})();
