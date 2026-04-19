(function () {
  'use strict';

  // ── Locate the <script> tag ───────────────────────────────────────────────────
  var script = document.currentScript ||
    (function () {
      var all = document.querySelectorAll('script[src*="loader.js"]');
      return all[all.length - 1];
    })();

  // ── Read configuration attributes ────────────────────────────────────────────
  //
  //  data-url          Base URL of the widget app (default: auto-detected from script src)
  //  data-name         Agent display name            (default: "MyAgent")
  //  data-color-from   Gradient start color (hex)    (default: "#6366f1")
  //  data-color-to     Gradient end color   (hex)    (default: "#06b6d4")
  //
  //  Example:
  //  <script src="https://example.com/loader.js"
  //          data-name="Aria"
  //          data-color-from="#f43f5e"
  //          data-color-to="#f97316">
  //  </script>

  function attr(name, fallback) {
    return (script && script.getAttribute(name)) || fallback;
  }

  var baseUrl    = attr('data-url', (script && script.src.replace(/\/loader\.js.*$/, '')) || 'http://localhost:4200');
  var agentName  = attr('data-name',         'MyAgent');
  var agentProfile = attr('data-profile',    'STANDARD');
  var agentAvatar = attr('data-avatar',      '');
  var colorFrom  = attr('data-color-from',   '#6366f1');
  var colorMid   = attr('data-color-mid',    '#8b5cf6');
  var colorTo    = attr('data-color-to',     '#06b6d4');

  // ── Build iframe src with query params ───────────────────────────────────────
  var paramsObj = {
    name:      agentName,
    profile:   agentProfile,
    colorFrom: colorFrom,
    colorMid:  colorMid,
    colorTo:   colorTo,
  };
  if (agentAvatar) paramsObj.avatar = agentAvatar;
  var params = new URLSearchParams(paramsObj);

  // ── Sizes ────────────────────────────────────────────────────────────────────
  var CLOSED = { w: 88,  h: 88  };
  var OPEN   = { w: 420, h: 900 };

  // ── Create iframe ────────────────────────────────────────────────────────────
  var iframe = document.createElement('iframe');
  iframe.src = baseUrl + '/?' + params.toString();
  iframe.title = agentName;
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('scrolling', 'no');
  iframe.setAttribute('allowtransparency', 'true');
  iframe.setAttribute('allow', 'microphone');
  iframe.setAttribute('style', [
    'position:fixed',
    'bottom:0',
    'right:0',
    'border:none',
    'background:transparent',
    'z-index:2147483647',
    'overflow:hidden',
    'color-scheme:normal',
    'transition:width 0.25s cubic-bezier(0.34,1.4,0.64,1),height 0.25s cubic-bezier(0.34,1.4,0.64,1)',
    'width:'  + CLOSED.w + 'px',
    'height:' + CLOSED.h + 'px',
  ].join(';'));

  // ── Inject ───────────────────────────────────────────────────────────────────
  if (document.body) {
    document.body.appendChild(iframe);
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      document.body.appendChild(iframe);
    });
  }

  // ── Resize on open/close messages ────────────────────────────────────────────
  window.addEventListener('message', function (event) {
    if (!event.data || event.data.source !== 'myagent-fe-widget') return;
    if (event.source !== iframe.contentWindow) return;

    if (event.data.type === 'CHAT_OPENED') {
      iframe.style.width  = OPEN.w + 'px';
      iframe.style.height = OPEN.h + 'px';
    } else if (event.data.type === 'CHAT_CLOSED') {
      iframe.style.width  = CLOSED.w + 'px';
      iframe.style.height = CLOSED.h + 'px';
    }
  });

  // ── Close chat when clicking outside the iframe ───────────────────────────────
  document.addEventListener('click', function (event) {
    if (event.target !== iframe) {
      iframe.contentWindow.postMessage({ type: 'CLOSE_CHAT', source: 'myagent-fe-host' }, '*');
    }
  });

})();
