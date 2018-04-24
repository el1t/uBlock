/*******************************************************************************

    uBlock - a browser extension to block requests.
    Copyright (C) 2014-2016 The uBlock authors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

/* global self, safari, SafariBrowserTab, µBlock */

// For background page

'use strict';

/******************************************************************************/

(function() {

var vAPI = self.vAPI = self.vAPI || {};

vAPI.isMainProcess = true;
vAPI.safari = true;

/******************************************************************************/

vAPI.app = {
    name: 'uBlock Origin',
    version: safari.extension.displayVersion
};

/******************************************************************************/

if ( navigator.userAgent.indexOf('Safari/6') === -1 ) { // If we're not on at least Safari 8
    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u) {
        if ( u.lastIndexOf('safari-extension:', 0) === 0 ) {
            var i = u.length, seeDot = false;
            while ( i-- ) {
                if ( u[i] === '.' ) {
                    seeDot = true;
                } else if ( u[i] === '/' ) {
                    break;
                }
            }
            if ( seeDot === false ) {
                throw 'InvalidAccessError'; // Avoid crash
                return;
            }
        }
        _open.apply(this, arguments);
    };
}

/******************************************************************************/

vAPI.app.restart = function() {
    µBlock.restart();
};

/******************************************************************************/

safari.extension.settings.addEventListener('change', function(e) {
    if ( e.key === 'open_prefs' ) {
        vAPI.tabs.open({
            url: 'dashboard.html',
            active: true
        });
    }
}, false);

vAPI.storage = {
    _storage: safari.extension.settings,
    get: function(keys, callback) {
        if ( typeof callback !== 'function' ) {
            return;
        }

        var i, value, result = {};

        if ( keys === null ) {
            for ( i in this._storage ) {
                if ( !this._storage.hasOwnProperty(i) ) continue;
                value = this._storage[i];
                if ( typeof value === 'string' ) {
                    result[i] = JSON.parse(value);
                }
            }
        } else if ( typeof keys === 'string' ) {
            value = this._storage[keys];
            if ( typeof value === 'string' ) {
                result[keys] = JSON.parse(value);
            }
        } else if ( Array.isArray(keys) ) {
            for ( i = 0; i < keys.length; i++ ) {
                value = this._storage[keys[i]];

                if ( typeof value === 'string' ) {
                    result[keys[i]] = JSON.parse(value);
                }
            }
        } else if ( typeof keys === 'object' ) {
            for ( i in keys ) {
                if ( !keys.hasOwnProperty(i) ) {
                    continue;
                }
                value = this._storage[i];

                if ( typeof value === 'string' ) {
                    result[i] = JSON.parse(value);
                } else {
                    result[i] = keys[i];
                }
            }
        }
        callback(result);
    },
    set: function(details, callback) {
        for ( var key in details ) {
            if ( !details.hasOwnProperty(key) ) {
                continue;
            }
            this._storage.setItem(key, JSON.stringify(details[key]));
        }
        if ( typeof callback === 'function' ) {
            callback();
        }
    },
    remove: function(keys) {
        if ( typeof keys === 'string' ) {
            keys = [keys];
        }
        for ( var i = 0; i < keys.length; i++ ) {
            this._storage.removeItem(keys[i]);
        }
    },
    clear: function(callback) {
        this._storage.clear();
        // Assuming callback will be called after clear
        if ( typeof callback === 'function' ) {
            callback();
        }
    }
    // No getBytesInUse; too slow
};

/******************************************************************************/

vAPI.tabs = {
    stack: Object.create(null),
    stackId: 1
};

/******************************************************************************/

vAPI.isBehindTheSceneTabId = function(tabId) {
    return tabId < 0;
};

vAPI.noTabId = '-1';

/******************************************************************************/

vAPI.tabs.registerListeners = function() {
    safari.application.addEventListener('beforeNavigate', function(e) {
        if ( !vAPI.tabs.popupCandidate || !e.target || e.url === 'about:blank' ) {
            return;
        }

        var targetUrl = e.url,
            targetTabId = vAPI.tabs.getTabId(e.target).toString(),
            openerTabId = vAPI.tabs.popupCandidate;
        vAPI.tabs.popupCandidate = false;
        if ( vAPI.tabs.onPopupUpdated(targetTabId, openerTabId, targetUrl) ) {
            e.preventDefault();
            if ( vAPI.tabs.stack[openerTabId] ) {
                vAPI.tabs.stack[openerTabId].activate();
            }
        }
    }, true);
    // onClosed handled in the main tab-close event
    // onUpdated handled via monitoring the history.pushState on web-pages
    // onPopup is handled in window.open on web-pages
    safari.application.addEventListener('activate', function(e) {
        vAPI.contextMenu.onMustUpdate(vAPI.tabs.getTabId(e.target));
    }, true);
};

/******************************************************************************/

vAPI.tabs.getTabId = function(tab) {
    if ( typeof tab.uBlockCachedID !== 'undefined' ) {
        return tab.uBlockCachedID;
    }
    for ( var tabId in vAPI.tabs.stack ) {
        if ( vAPI.tabs.stack[tabId] === tab ) {
            return (tab.uBlockCachedID = +tabId);
        }
    }

    return -1;
};

/******************************************************************************/

vAPI.tabs.get = function(tabId, callback) {
    var tab;

    if ( tabId === null ) {
        tab = safari.application.activeBrowserWindow.activeTab;
        tabId = this.getTabId(tab);
    } else {
        tab = this.stack[tabId];
    }

    if ( !tab ) {
        callback();
        return;
    }

    callback({
        id: tabId,
        index: tab.browserWindow.tabs.indexOf(tab),
        windowId: safari.application.browserWindows.indexOf(tab.browserWindow),
        active: tab === tab.browserWindow.activeTab,
        url: tab.url || 'about:blank',
        title: tab.title
    });
};

/******************************************************************************/

// properties of the details object:
//   url: 'URL', // the address that will be opened
//   tabId: 1, // the tab is used if set, instead of creating a new one
//   index: -1, // undefined: end of the list, -1: following tab, or after index
//   active: false, // opens the tab in background - true and undefined: foreground
//   select: true, // if a tab is already opened with that url, then select it instead of opening a new one
//   popup: true // open in a new window

vAPI.tabs.open = function(details) {
    if ( !details.url ) {
        return null;
    }
    // extension pages
    if ( /^[\w-]{2,}:/.test(details.url) === false ) {
        details.url = vAPI.getURL(details.url);
    }

    var curWin, tab;

    // Open in a standalone window
    if ( details.popup === true ) {
        tab = safari.application.openBrowserWindow().activeTab;
        tab.url = details.url;
        return tab;
    }

    if ( details.select ) {
        var findTab;
        var pos = details.url.indexOf('#');
        var url = details.url;
        if ( pos === -1 ) {
            findTab = function(win) {
                for ( var i = 0; i < win.tabs.length; i++ ) {
                    if ( win.tabs[i].url === url ) {
                        win.tabs[i].activate();
                        tab = win.tabs[i];
                        return true;
                    }
                }
            }
        } else {
            // Remove fragment identifiers
            url = url.slice(0, pos);
            findTab = function(win) {
                for ( var i = 0; i < win.tabs.length; i++ ) {
                    // Some tabs don't have a URL
                    if ( win.tabs[i].url &&
                        win.tabs[i].url.slice(0, pos) === url ) {
                        win.tabs[i].activate();
                        tab = win.tabs[i];
                        return true;
                    }
                }
            }
        }

        if ( safari.application.browserWindows.some(findTab) ) {
            return tab;
        }
    }

    if ( details.active === undefined ) {
        details.active = true;
    }

    curWin = safari.application.activeBrowserWindow;

    // it must be calculated before opening a new tab,
    // otherwise the new tab will be the active tab here
    if ( details.index === -1 ) {
        details.index = curWin.tabs.indexOf(curWin.activeTab) + 1;
    }

    tab = (details.tabId ? this.stack[details.tabId] : curWin.openTab(details.active ? 'foreground' : 'background'));

    if ( details.index !== undefined ) {
        curWin.insertTab(tab, details.index);
    }

    tab.url = details.url;
    return tab;
};

/******************************************************************************/

// Replace the URL of a tab. Noop if the tab does not exist.

vAPI.tabs.replace = function(tabId, url) {
    var targetURL = url;

    // extension pages
    if ( /^[\w-]{2,}:/.test(targetURL) !== true ) {
        targetURL = vAPI.getURL(targetURL);
    }

    var tab = this.stack[tabId];
    if ( tab ) {
        tab.url = targetURL;
    }
};

/******************************************************************************/

vAPI.tabs.remove = function(tabIds) {
    if ( tabIds instanceof SafariBrowserTab ) {
        tabIds = this.getTabId(tabIds);
    }

    if ( !Array.isArray(tabIds) ) {
        tabIds = [tabIds];
    }

    for ( var i = 0; i < tabIds.length; i++ ) {
        if ( this.stack[tabIds[i]] ) {
            this.stack[tabIds[i]].close();
        }
    }
};

/******************************************************************************/

vAPI.tabs.reload = function(tabId) {
    var tab = this.stack[tabId];

    if ( tab ) {
        tab.url = tab.url;
    }
};

/******************************************************************************/

vAPI.tabs.select = function(tabId) {
    if ( tabId === 0 ) return;
    this.stack[tabId].activate();
};

/******************************************************************************/

vAPI.tabs.injectScript = function(tabId, details, callback) {
    var tab;

    if ( tabId ) {
        tab = this.stack[tabId];
    } else {
        tab = safari.application.activeBrowserWindow.activeTab;
    }

    if ( details.file ) {
        details.file = vAPI.getURL(details.file)
        var xhr = new XMLHttpRequest();
        xhr.open('GET', details.file, true);
        xhr.addEventListener('readystatechange', function() {
            if ( this.readyState === 4 ) {
                details.code = xhr.responseText;
                tab.page.dispatchMessage('broadcast', {
                    channelName: 'vAPI',
                    msg: {
                        cmd: 'injectScript',
                        details: details
                    }
                });
                if ( typeof callback === 'function' ) {
                    setTimeout(callback, 13);
                }
            }
        });
        xhr.send();
    }
};

/******************************************************************************/

// reload the popup when it's opened
safari.application.addEventListener('popover', function(event) {
    var w = event.target.contentWindow, body = w.document.body, child;
    while ( child = body.firstChild ) {
        body.removeChild(child);
    }
    w.location.reload();
}, true);

/******************************************************************************/

var ICON_URLS = {
    'on': vAPI.getURL('img/browsericons/safari-icon16.png'),
    'off': vAPI.getURL('img/browsericons/safari-icon16-off.png')
};

var IconState = function(badge, img, icon) {
    this.badge = badge;
    // ^ a number -- the badge 'value'
    this.img = img;
    // ^ a string -- 'on' or 'off'
    this.active = false;
    // ^ is this IconState active for rendering?
    this.icon = typeof icon !== 'undefined' ? icon : null;
    // ^ the corresponding browser toolbar-icon object
    this.dirty = (1 << 1) | (1 << 0);
    /* ^ bitmask AB: two bits, A and B
     where A is whether img has changed and needs render
     and B is whether badge has changed and needs render */
};

var iconStateForTabId = {}; // {tabId: IconState}

var getIconForWindow = function(whichWindow) {
    // do we already have the right icon cached?
    if ( typeof whichWindow.uBlockIcon !== 'undefined' ) {
        return whichWindow.uBlockIcon;
    }

    // iterate through the icons to find the one which
    // belongs to this window (whichWindow)
    var items = safari.extension.toolbarItems;
    for ( var i = 0; i < items.length; i++ ) {
        if ( items[i].browserWindow === whichWindow ) {
            return (whichWindow.uBlockIcon = items[i]);
        }
    }
};

safari.application.addEventListener('activate', function(event) {
    if ( !(event.target instanceof SafariBrowserTab) ) {
        return;
    }

    // when a tab is activated...
    var tab = event.target;
    if ( tab.browserWindow !== tab.oldBrowserWindow ) {
        // looks like tab is now associated with a new window
        tab.oldBrowserWindow = tab.browserWindow;
        // so, unvalidate icon
        tab.uBlockKnowsIcon = false;
    }

    var tabId = vAPI.tabs.getTabId(tab),
        state = iconStateForTabId[tabId];
    if ( typeof state === 'undefined' ) {
        state = iconStateForTabId[tabId] = new IconState(0, 'on');
        // need to get the icon for this newly-encountered tab...
        // uBlockKnowsIcon should be undefined here, so in theory
        // we don't need this -- but to be sure,
        // go ahead and explicitly unvalidate
        tab.uBlockKnowsIcon = false;
    }

    if ( !tab.uBlockKnowsIcon ) {
        // need to find the icon for this tab's window
        state.icon = getIconForWindow(tab.browserWindow);
        tab.uBlockKnowsIcon = true;
    }
    state.active = true;
    // force re-render since we probably switched tabs
    state.dirty = (1 << 1) | (1 << 0);
    renderIcon(state);
}, true);

safari.application.addEventListener('deactivate', function(event) {
    if ( !(event.target instanceof SafariBrowserTab) ) {
        return;
    }

    // when a tab is deactivated...
    var tabId = vAPI.tabs.getTabId(event.target),
        state = iconStateForTabId[tabId];
    if ( typeof state === 'undefined' ) {
        return;
    }
    // mark its iconState as inactive so we don't visually
    // render changes for now
    state.active = false;
}, true);

var renderIcon = function(iconState) {
    if ( iconState.dirty === 0 ) {
        // quit if we don't need to touch the 'DOM'
        return;
    }
    var icon = iconState.icon;
    // only update the image if needed:
    if ( iconState.dirty & 2 ) {
        icon.badge = iconState.badge;
    }
    if ( (iconState.dirty & 1) && icon.image !== ICON_URLS[iconState.img] ) {
        icon.image = ICON_URLS[iconState.img];
    }
    iconState.dirty = 0;
};

vAPI.setIcon = function(tabId, iconStatus, badge) {
    badge = badge || 0;

    var state = iconStateForTabId[tabId];
    if ( typeof state === 'undefined' ) {
        state = iconStateForTabId[tabId] = new IconState(badge, iconStatus);
    } else {
        state.dirty = ((state.badge !== badge) << 1) | ((state.img !== iconStatus) << 0);
        state.badge = badge;
        state.img = iconStatus;
    }
    if ( state.active === true ) {
        renderIcon(state);
    }
    vAPI.contextMenu.onMustUpdate(tabId);
};

/******************************************************************************/

// bind tabs to unique IDs

(function() {
    var wins = safari.application.browserWindows,
        i = wins.length,
        j,
        curTab,
        curTabId,
        curWindow;
    while ( i-- ) {
        curWindow = wins[i];
        j = curWindow.tabs.length;
        while ( j-- ) {
            curTab = wins[i].tabs[j];
            curTabId = vAPI.tabs.stackId++;
            iconStateForTabId[curTabId] = new IconState(0, 'on', getIconForWindow(curWindow));
            curTab.uBlockKnowsIcon = true;
            if ( curWindow.activeTab === curTab ) {
                iconStateForTabId[curTabId].active = true;
            }
            vAPI.tabs.stack[curTabId] = curTab;
        }
    }
})();

/******************************************************************************/

safari.application.addEventListener('open', function(e) {
    // ignore windows
    if ( e.target instanceof SafariBrowserTab ) {
        vAPI.tabs.stack[vAPI.tabs.stackId++] = e.target;
    }
}, true);

/******************************************************************************/

safari.application.addEventListener('close', function(e) {
    // ignore windows
    if ( !(e.target instanceof SafariBrowserTab) ) {
        return;
    }

    var tabId = vAPI.tabs.getTabId(e.target);

    if ( tabId !== -1 ) {
        // to not add another listener, put this here
        // instead of vAPI.tabs.registerListeners
        if ( typeof vAPI.tabs.onClosed === 'function' ) {
            vAPI.tabs.onClosed(tabId);
        }

        delete vAPI.tabs.stack[tabId];
        delete iconStateForTabId[tabId];
    }
}, true);

/******************************************************************************/
vAPI.messaging = {
    listeners: {},
    defaultHandler: null,
    NOOPFUNC: function() {},
    UNHANDLED: 'vAPI.messaging.notHandled'
};

/******************************************************************************/

vAPI.messaging.listen = function(listenerName, callback) {
    this.listeners[listenerName] = callback;
};

/******************************************************************************/

// CallbackWrapper.prototype.proxy = function(response) {
//     this.port.dispatchMessage(this.request.name, {
//         requestId: this.request.message.requestId,
//         channelName: this.request.message.channelName,
//         msg: response !== undefined ? response: null
//     });
//     this.port = this.request = null;
//     CallbackWrapper.junkyard.push(this);
// };

vAPI.messaging.onMessage = (function() {
    var messaging = vAPI.messaging;
    var toAuxPending = {};

    // Use a wrapper to avoid closure and to allow reuse.
    var CallbackWrapper = function(port, request, timeout) {
        this.callback = this.proxy.bind(this); // bind once
        this.init(port, request, timeout);
    };

    CallbackWrapper.prototype.init = function(port, request, timeout) {
        this.port = port;
        // port.target.page could be undefined at this point, but be valid later
        // e.g. when preloading a page on a new tab
        this.request = request || port;
        this.timerId = timeout !== undefined ?
            vAPI.setTimeout(this.callback, timeout) :
            null;
        return this;
    };

    CallbackWrapper.prototype.proxy = function(response) {
        if ( this.timerId !== null ) {
            clearTimeout(this.timerId);
            delete toAuxPending[this.timerId];
            this.timerId = null;
        }
        // If page is undefined, we cannot send a message to it (and probably don't want to)
        var page = this.port.target.page;
        if ( page && typeof page.dispatchMessage === 'function' ) {
            page.dispatchMessage(this.request.name, {
                auxProcessId: this.request.message.auxProcessId,
                channelName: this.request.message.channelName,
                msg: response !== undefined ? response : null
            });
        }
        // Mark for reuse
        this.port = this.request = null;
        callbackWrapperJunkyard.push(this);
    };

    var callbackWrapperJunkyard = [];

    var callbackWrapperFactory = function(port, request, timeout) {
        var wrapper = callbackWrapperJunkyard.pop();
        if ( wrapper ) {
            return wrapper.init(port, request, timeout);
        }
        return new CallbackWrapper(port, request, timeout);
    };

    var toAux = function(details, portFrom) {
        var port, portTo;
        // var chromiumTabId = details.toTabId; //toChromiumTabId(details.toTabId);

        // TODO: This could be an issue with a lot of tabs: easy to address
        //       with a port name to tab id map.
        // for ( var portName in messaging.ports ) {
        //     if ( messaging.ports.hasOwnProperty(portName) === false ) {
        //         continue;
        //     }
        //     // When sending to an auxiliary process, the target is always the
        //     // port associated with the root frame.
        //     port = messaging.ports[portName];
        //     if ( port.sender.frameId === 0 && port.sender.tab.id === chromiumTabId ) {
        //         portTo = port;
        //         break;
        //     }
        // }

        var wrapper;
        if ( details.auxProcessId !== undefined ) {
            wrapper = callbackWrapperFactory(portFrom, details, 1023);
        }

        // Destination not found:
        if ( portTo === undefined ) {
            if ( wrapper !== undefined ) {
                wrapper.callback();
            }
            return;
        }

        // As per HTML5, timer id is always an integer, thus suitable to be
        // used as a key, and which value is safe to use across process
        // boundaries.
        if ( wrapper !== undefined ) {
            toAuxPending[wrapper.timerId] = wrapper;
        }

        // portTo.postMessage({
        //     mainProcessId: wrapper && wrapper.timerId,
        //     channelName: details.toChannel,
        //     msg: details.msg
        // });
        portTo.dispatchMessage(wrapper && wrapper.timerId, {
            mainProcessId: wrapper && wrapper.timerId,
            channelName: details.toChannel,
            msg: details.msg
        });
    };

    var toAuxResponse = function(details) {
        var mainProcessId = details.mainProcessId;
        if ( mainProcessId === undefined ) {
            return;
        }
        if ( toAuxPending.hasOwnProperty(mainProcessId) === false ) {
            return;
        }
        var wrapper = toAuxPending[mainProcessId];
        delete toAuxPending[mainProcessId];
        wrapper.callback(details.msg);
    };

    return function(request) {
        var message = request.message;

        // Auxiliary process to auxiliary process
        if ( message.toTabId !== undefined ) {
            // TODO: this doesn't work.
            toAux(message, request);
            return;
        }

        // Auxiliary process to auxiliary process: response
        if ( message.mainProcessId !== undefined ) {
            toAuxResponse(message);
            return;
        }

        // Auxiliary process to main process: prepare response
        var callback = messaging.NOOPFUNC;
        if ( message.auxProcessId !== undefined ) {
            callback = callbackWrapperFactory(request).callback;
        }

        var sender = {
            tab: {
                id: vAPI.tabs.getTabId(request.target)
            }
        };

        // Auxiliary process to main process: specific handler
        var r = messaging.UNHANDLED;
        var listener = messaging.listeners[message.channelName];
        if ( typeof listener === 'function' ) {
            r = listener(message.msg, sender, callback);
            if ( r !== messaging.UNHANDLED ) {
                return;
            }
        }

        // Auxiliary process to main process: default handler
        r = messaging.defaultHandler(message.msg, sender, callback);
        if ( r !== messaging.UNHANDLED ) {
            return;
        }

        // Auxiliary process to main process: no handler
        console.error('uBlock> messaging > unknown request: %o', message);

        // Need to callback anyways in case caller expected an answer, or
        // else there is a memory leak on caller's side
        callback();
    };
})();

/******************************************************************************/

vAPI.messaging.setup = function(defaultHandler) {
    // Already setup?
    if ( this.defaultHandler !== null ) {
        return;
    }

    if ( typeof defaultHandler !== 'function' ) {
        defaultHandler = function() {
            return vAPI.messaging.UNHANDLED;
        };
    }
    this.defaultHandler = defaultHandler;

    // the third parameter must stay false (bubbling), so later
    // onBeforeRequest will use true (capturing), where we can invoke
    // stopPropagation() (this way this.onMessage won't be fired)
    safari.application.addEventListener('message', this.onMessage, false);
};

/******************************************************************************/

vAPI.messaging.broadcast = function(message) {
    message = {
        broadcast: true,
        msg: message
    };
    var page;
    for ( var tabId in vAPI.tabs.stack ) {
        page = vAPI.tabs.stack[tabId].page;
        // page is undefined on new tabs
        if ( page && typeof page.dispatchMessage === 'function' ) {
            page.dispatchMessage('broadcast', message);
        }
    }
};

/******************************************************************************/


/******************************************************************************/

vAPI.contextMenu = {
    _callback: null,
    _entries: [],
    _contextMap: {
        frame: 'insideFrame',
        link: 'linkHref',
        image: 'srcUrl',
        editable: 'editable'
    },
    onContextMenu: function(e) {
        var uI = e.userInfo;

        if ( !uI || /^https?:\/\//i.test(uI.pageUrl) === false ) {
            return;
        }

        var invalidContext, entry, ctx;
        var entries = vAPI.contextMenu._entries,
            ctxMap = vAPI.contextMenu._contextMap;
        for ( var i = 0; i < entries.length; i++ ) {
            entry = entries[i];
            invalidContext = true;

            for ( var j = 0; j < entry.contexts.length; j++ ) {
                ctx = entry.contexts[j];

                if ( uI[ctxMap[ctx]] || ctx === 'all' ) {
                    invalidContext = false;
                    break;
                } else if ( ctx === 'audio' || ctx === 'video' ) {
                    if ( uI[ctxMap['image']] && uI.tagName === ctx ) {
                        invalidContext = false;
                        break;
                    }
                } else if ( ctx === 'page' ) {
                    if ( !(uI.insideFrame || uI.linkHref || uI.mediaType || uI.editable) ) {
                        invalidContext = false;
                        break;
                    }
                }
            }

            if ( invalidContext ) {
                continue;
            }
            e.contextMenu.appendContextMenuItem(entry.id, entry.title);
        }
    },
    onContextMenuCmd: function(e) {
        var entryId;
        var entries = vAPI.contextMenu._entries;
        for ( var i = 0; i < entries.length; i++ ) {
            entryId = entries[i].id;
            if ( e.command === entryId ) {
                var tab = e.currentTarget.activeBrowserWindow.activeTab;
                e.userInfo.menuItemId = entryId;
                vAPI.contextMenu._callback(e.userInfo, tab ? {
                        id: vAPI.tabs.getTabId(tab),
                        url: tab.url
                    } : undefined);
            }
        }
    },
    onMustUpdate: function() {},
    setEntries: function(entries, callback) {
        entries = entries || [];
        this._entries = entries;
        callback = callback || null;
        if ( callback === this._callback ) {
            return;
        }
        if ( entries.length !== 0 && callback !== null ) {
            safari.application.addEventListener('contextmenu', this.onContextMenu);
            safari.application.addEventListener('command', this.onContextMenuCmd);
            this._callback = callback;
        } else if ( entries.length === 0 && this._callback !== null ) {
            safari.application.removeEventListener('contextmenu', this.onContextMenu);
            safari.application.removeEventListener('command', this.onContextMenuCmd);
            this._callback = null;
        }
    }
};

/******************************************************************************/

vAPI.lastError = function() {
    return null;
};

/******************************************************************************/

// This is called only once, when everything has been loaded in memory after
// the extension was launched. It can be used to inject content scripts
// in already opened web pages, to remove whatever nuisance could make it to
// the web pages before uBlock was ready.

vAPI.onLoadAllCompleted = function() {};

/******************************************************************************/

vAPI.punycodeHostname = function(hostname) {
    return hostname;
};

vAPI.punycodeURL = function(url) {
    return url;
};


/******************************************************************************/
/******************************************************************************/

// https://github.com/gorhill/uBlock/issues/531
// Storage area dedicated to admin settings. Read-only.

vAPI.adminStorage = {
    getItem: function(key, callback) {
        if ( typeof callback !== 'function' ) {
            return;
        }
        // skip functionality
        callback(vAPI.localStorage.getItem(key));
    }
};

})();
