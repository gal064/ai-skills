# Injected by `bu SESSION_ID` before the caller's Browser Use code.
# It makes tab ownership survive across separate sandboxed terminal calls.
#
# Ownership lives here, on disk, and nowhere else. A session owns the tabs it
# opens with new_tab() and any tab it switches into. A session that has not
# opened one yet claims the daemon's blank initial tab, so it never works in a
# tab no guard protects and --end cannot reclaim.
_bu_session_id = os.environ["BU_SESSION_ID"]
_bu_state_dir = Path(os.environ["BH_HOME"]) / "sessions"
_bu_state_dir.mkdir(parents=True, exist_ok=True)
_bu_tabs_file = _bu_state_dir / f"{_bu_session_id}.tabs"


def _bu_target_id(target):
    if isinstance(target, dict):
        return target.get("targetId") or target.get("target_id")
    return target


def _bu_read_tabs(path=None):
    """Owned tab ids, oldest first. The last entry is the session's current tab."""
    path = path or _bu_tabs_file
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        # _bu_owner_of reads every session's record, so one unreadable file must
        # not raise and take the ownership guard down for all of them.
        return []
    return [line.strip() for line in text.splitlines() if line.strip()]


def _bu_write_tabs(tabs):
    if not tabs:
        _bu_tabs_file.unlink(missing_ok=True)
        return
    # Replace atomically: a partial write would leave a truncated id that the
    # guard reads as a different tab, so the real tab would look unowned.
    tmp = _bu_tabs_file.parent / f"{_bu_tabs_file.name}.{os.getpid()}.tmp"
    tmp.write_text("\n".join(tabs) + "\n", encoding="utf-8")
    os.replace(tmp, _bu_tabs_file)


def _bu_own(target_id):
    """Record a tab as owned and make it current."""
    if not target_id:
        return target_id
    tabs = [t for t in _bu_read_tabs() if t != target_id]
    tabs.append(target_id)
    _bu_write_tabs(tabs)
    return target_id


def _bu_owner_of(target_id):
    """Session that owns a tab, or None when no session claims it."""
    if not target_id:
        return None
    for path in sorted(_bu_state_dir.glob("*.tabs")):
        if target_id in _bu_read_tabs(path):
            return path.stem
    return None


def _bu_guard(target_id, action):
    """Refuse to touch a tab another session owns."""
    owner = _bu_owner_of(target_id)
    if owner and owner != _bu_session_id:
        raise PermissionError(
            f"bu session {_bu_session_id!r} may not {action} tab {target_id}: "
            f"it belongs to session {owner!r}. Call new_tab() to get your own tab."
        )
    return target_id


# Wrap only the helpers this Browser Use build actually exposes, so a renamed
# or removed upstream helper cannot break every session at import time.
_bu_wrapped_names = ("new_tab", "close_tab", "switch_tab", "activate_tab", "ensure_real_tab", "js")
_bu_originals = {name: globals()[name] for name in _bu_wrapped_names if name in globals()}
_bu_required = [name for name in ("switch_tab", "close_tab") if name not in _bu_originals]
if _bu_required:
    raise RuntimeError(
        "bu: this Browser Use build is missing required helpers: " + ", ".join(_bu_required)
    )
_bu_original_close_tab = _bu_originals["close_tab"]
_bu_original_switch_tab = _bu_originals["switch_tab"]


def _bu_attached_tab():
    """The tab the daemon is attached to, or None. Never raises.

    Once the attached target dies, current_tab() raises cdp_disconnected, and
    the daemon replaces the target only on its next page-level CDP call, with a
    blank tab it opens itself. Make that happen now so the replacement is known
    and can be claimed or closed, rather than becoming a stray tab no session
    records. Raising instead would abort the call before the survival check
    below could report the loss.
    """
    try:
        return current_tab()
    except Exception:
        pass
    try:
        cdp("Runtime.evaluate", expression="0")
        return current_tab()
    except Exception:
        return None


_bu_bootstrap_target = _bu_attached_tab()


# Target.closeTarget returns before Chrome drops the tab, so a tab closed in
# this call can still be listed. Never treat one as live, or a second close in
# a row would move into the dying tab.
_bu_closed_this_call = set()


def _bu_live_target_ids():
    return {
        tab.get("targetId") or tab.get("target_id")
        for tab in list_tabs(include_chrome=True)
    } - _bu_closed_this_call


def _bu_close_bootstrap_target(owned_target_id):
    """Discard the daemon's dedicated tab once the session has its own."""
    global _bu_bootstrap_target
    bootstrap_id = _bu_target_id(_bu_bootstrap_target)
    _bu_bootstrap_target = None
    if not bootstrap_id or bootstrap_id == owned_target_id:
        return
    # This session may have claimed the tab below; never touch anyone else's.
    if _bu_owner_of(bootstrap_id) not in (None, _bu_session_id):
        return
    # Read the URL now: an attached tab may have navigated since prelude time.
    bootstrap_url = None
    for tab in list_tabs(include_chrome=True):
        if (tab.get("targetId") or tab.get("target_id")) == bootstrap_id:
            bootstrap_url = tab.get("url", "")
            break
    if bootstrap_url != "about:blank":
        return
    _bu_original_close_tab(bootstrap_id)
    _bu_write_tabs([t for t in _bu_read_tabs() if t != bootstrap_id])


_bu_owned_tabs = _bu_read_tabs()
if _bu_owned_tabs:
    _bu_live = _bu_live_target_ids()
    _bu_surviving = [t for t in _bu_owned_tabs if t in _bu_live]
    if not _bu_surviving:
        _bu_close_bootstrap_target(None)
        _bu_write_tabs([])
        raise RuntimeError(
            f"bu session {_bu_session_id!r} lost its owned tab; "
            "start the workflow again with new_tab()"
        )
    if _bu_surviving != _bu_owned_tabs:
        _bu_write_tabs(_bu_surviving)
    _bu_original_switch_tab(_bu_surviving[-1])
    _bu_close_bootstrap_target(_bu_surviving[-1])
else:
    # Upstream never calls ensure_real_tab() for us, so a session that skips
    # new_tab() drives the daemon's initial tab. Claim it, but only when it is
    # an unowned about:blank tab, which is how a named daemon creates its own.
    _bu_bootstrap_id = _bu_target_id(_bu_bootstrap_target)
    if (
        _bu_bootstrap_id
        and _bu_bootstrap_target.get("url") == "about:blank"
        and _bu_owner_of(_bu_bootstrap_id) is None
    ):
        _bu_own(_bu_bootstrap_id)


def _bu_new_tab(url="about:blank"):
    """Open a tab owned by this session.

    Always creates a fresh target: upstream new_tab() reuses the attached tab
    when it is blank, which would hand back the daemon's dedicated tab.
    """
    target_id = cdp("Target.createTarget", url="about:blank", background=True)["targetId"]
    _bu_own(target_id)
    _bu_original_switch_tab(target_id)
    _bu_close_bootstrap_target(target_id)
    if url != "about:blank":
        goto_url(url)
    return target_id


def _bu_switch_tab(target, activate=False):
    target_id = _bu_guard(_bu_target_id(target), "switch to")
    result = _bu_original_switch_tab(target, activate=activate)
    # The guard refused other sessions' tabs, so this one is ours or unowned.
    # Claim it: an unowned tab we drive, such as a popup, must be protected
    # from other sessions and closed when this session ends.
    _bu_own(target_id)
    return result


def _bu_activate_tab(target):
    _bu_guard(_bu_target_id(target), "activate")
    return _bu_originals["activate_tab"](target)


def _bu_close_tab(target=None):
    was_current = target is None
    target_id = _bu_target_id(target)
    if target_id is None:
        target_id = _bu_target_id(current_tab())
    else:
        try:
            was_current = _bu_target_id(current_tab()) == target_id
        except Exception:
            was_current = False
    _bu_guard(target_id, "close")
    remaining = []
    if was_current:
        # Move off the tab before closing it. Closing the attached target first
        # leaves the daemon on a dead session, and its next CDP call opens a
        # replacement blank tab that no session records.
        live_ids = _bu_live_target_ids()
        remaining = [t for t in _bu_read_tabs() if t != target_id and t in live_ids]
        if remaining:
            _bu_original_switch_tab(remaining[-1])
        else:
            # Nothing to move to, so open the replacement ourselves and own it.
            # Waiting for the daemon's would race the close: Target.closeTarget
            # returns while the old tab still reports as attached.
            replacement = cdp("Target.createTarget", url="about:blank", background=True)["targetId"]
            _bu_own(replacement)
            _bu_original_switch_tab(replacement)
    result = _bu_original_close_tab(target_id)
    _bu_closed_this_call.add(target_id)
    # Ownership is not dropped here. Target.closeTarget can return before the
    # target is gone, and a close that silently fails must leave the tab owned
    # so --end can still reclaim it. The resume path prunes ids that died.
    return result


def _bu_ensure_real_tab():
    """Return this session's current tab. Never wanders onto another tab."""
    owned = _bu_read_tabs()
    live_ids = _bu_live_target_ids()
    live = [t for t in owned if t in live_ids]
    if not live:
        raise RuntimeError(
            f"bu session {_bu_session_id!r} owns no live tab; call new_tab() first"
        )
    # Keep ids closed in this call: a close that silently failed must stay
    # owned so --end can reclaim it. The resume path prunes them once gone.
    kept = [t for t in owned if t in live_ids or t in _bu_closed_this_call]
    if kept != owned:
        _bu_write_tabs(kept)
    _bu_original_switch_tab(live[-1])
    return current_tab()


def _bu_js(expression, target_id=None):
    if target_id is not None:
        _bu_guard(_bu_target_id(target_id), "run JavaScript in")
    return _bu_originals["js"](expression, target_id=target_id)


for _bu_name, _bu_replacement in (
    ("new_tab", _bu_new_tab),
    ("switch_tab", _bu_switch_tab),
    ("activate_tab", _bu_activate_tab),
    ("close_tab", _bu_close_tab),
    ("ensure_real_tab", _bu_ensure_real_tab),
    ("js", _bu_js),
):
    if _bu_name in _bu_originals:
        globals()[_bu_name] = _bu_replacement
