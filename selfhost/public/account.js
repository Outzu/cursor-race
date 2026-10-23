/* The account chip. Lives in the hosted page rather than in the game, so the
   game file stays identical to the one published as an artifact. */

(function () {
  "use strict";

  var el = document.getElementById("account");
  if (!el) return;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function render(s) {
    if (s.account) {
      var name = s.account.name || s.account.email || "signed in";
      el.innerHTML =
        (s.account.picture
          ? '<img src="' + esc(s.account.picture) + '" alt="" referrerpolicy="no-referrer">'
          : '<span class="dot"></span>') +
        '<span class="nm">' + esc(name) + '</span>' +
        '<a class="act" href="/auth/logout">Sign out</a>';
    } else if (s.googleEnabled) {
      el.innerHTML =
        '<span class="nm guest">Playing as a guest</span>' +
        '<a class="act primary" href="/auth/google">Sign in with Google</a>';
    } else {
      el.remove();
      return;
    }
    el.hidden = false;
  }

  fetch("/api/session", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(render)
    .catch(function () { el.remove(); });

  if (location.search.indexOf("signin=failed") >= 0) {
    var warn = document.createElement("div");
    warn.id = "signin-failed";
    warn.textContent = "Sign-in did not complete. You are still playing as a guest.";
    document.body.appendChild(warn);
    setTimeout(function () { warn.remove(); }, 6000);
    history.replaceState(null, "", location.pathname);
  }
})();
