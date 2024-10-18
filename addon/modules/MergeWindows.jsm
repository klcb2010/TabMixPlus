"use strict";

const EXPORTED_SYMBOLS = ["MergeWindows"];

const {TabmixChromeUtils} = ChromeUtils.import("chrome://tabmix-resource/content/ChromeUtils.jsm");
const {AppConstants} = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
const {TabmixSvc} = ChromeUtils.import("chrome://tabmix-resource/content/TabmixSvc.jsm");

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  // Firefox 123 Bug 1864821 - Replace PromiseUtils.defer with Promise.withResolvers
  PromiseUtils: "resource://gre/modules/PromiseUtils.sys.mjs",
});

TabmixChromeUtils.defineLazyModuleGetters(lazy, {
  //
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.jsm",
});

//////////////////////////////////////////////////////////////////////
// The Original Code is the Merge Window function of "Duplicate Tab"//
// extension for Mozilla Firefox.                                   //
// version 0.5.1                                                    //
// The Initial Developer of the Original Code is Twanno.            //
// Modified for TMP by CPU                                           //
//                                                                  //
// Convert to module and modified by onemen                          //
//                                                                  //
//////////////////////////////////////////////////////////////////////
const MergeWindows = {
  get prefs() {
    delete this.prefs;
    return (this.prefs = Services.prefs.getBranch("extensions.tabmix."));
  },

  // merge several windows to one window, or only selected tabs to previous focused window,
  // or only current window with previous window
  mergeWindows: function _mergeWindows(aWindow) {
    var tabbrowser = aWindow.gBrowser;
    var mergeAllWindows = this.prefs.getBoolPref("mergeAllWindows");

    // check if one or more tabs are selected to be merged
    var selectedTabs = tabbrowser.tabContainer.getElementsByAttribute("mergeselected", true);
    let options = {
      skipPopup: !this.prefs.getBoolPref("mergePopups"),
      private: this.isWindowPrivate(aWindow),
      tabsSelected: Boolean(selectedTabs.length),
      multiple: mergeAllWindows && !selectedTabs.length
    };
    let {windows, normalWindowsCount} = this.getWindowsList(aWindow, options);
    if (!windows.length) {
      this.notify(aWindow, options.privateNotMatch);
    } else if (!normalWindowsCount && this.isPopupWindow(aWindow)) {
      windows.unshift(aWindow);
      this.mergePopUpsToNewWindow(windows, options.private);
    } else if (options.multiple) {
      options.normalWindowsCount = normalWindowsCount;
      this.mergeMultipleWindows(aWindow, windows, options);
    } else {
      let tabsToMove = Array.prototype.slice.call(options.tabsSelected ? selectedTabs : tabbrowser.tabs);
      this.mergeTwoWindows(windows[0], aWindow, tabsToMove, options);
    }
  },

  // merge current window into previously focused window, unless it was popup
  // in that case merge previously focused window into current window
  mergeTwoWindows: function TMP_mergeTwoWindows(aTargetWindow, aWindow, aTabs, aOptions) {
    let tabbrowser = aWindow.gBrowser;
    let canClose = aOptions.tabsSelected && tabbrowser.tabs.length > aTabs.length &&
                    this.warnBeforeClosingWindow(aWindow);
    if (this.isPopupWindow(aTargetWindow)) {
      if (aOptions.tabsSelected) {
        // merge tabs from the popup window into the current window
        // remove or move to new window tabs that wasn't selected
        for (let i = tabbrowser.tabs.length - 1; i >= 0; i--) {
          let tab = tabbrowser.tabs[i];
          if (tab.hasAttribute("mergeselected")) {
            tab.removeAttribute("mergeselected");
            tab.label = tab.label.substr(4);
            tabbrowser._tabAttrModified(tab, ["label"]);
          } else if (canClose) {
            tabbrowser.removeTab(tab);
          }
        }
        canClose = false;
      }
      [aTargetWindow, aTabs] = [aWindow, aTargetWindow.gBrowser.tabs];
    }
    this.swapTabs(aTargetWindow, aTabs);
    // _endRemoveTab set _windowIsClosing if the last tab moved to a different window
    if (canClose && !tabbrowser._windowIsClosing)
      aWindow.close();
  },

  // merge all suitable windows into the current window unless it is popup
  mergeMultipleWindows: function TMP_mergeMultipleWindows(aTargetWindow, aWindows, aOptions) {
    if (this.isPopupWindow(aTargetWindow)) {
      // we have at least one non-popup windows, so we can merge all windows
      // into the first window in the list.
      // when we don't merge popups, allow to merge the current popup window
      // if there is only one non-popup window.
      if (!aOptions.skipPopup || aOptions.normalWindowsCount == 1)
        aWindows.splice(aOptions.normalWindowsCount, 0, aTargetWindow);
      aTargetWindow = aWindows.shift();
    }
    this.concatTabsAndMerge(aTargetWindow, aWindows);
  },

  mergePopUpsToNewWindow(aWindows, aPrivate) {
    const tabsToMove = aWindows.reduce((tabs, win) => [...tabs, ...win.gBrowser.tabs], []);
    const firstTab = tabsToMove.shift();

    let features = "chrome,all,dialog=no";
    features += aPrivate ? ",private" : ",non-private";
    let newWindow = aWindows[0].openDialog(AppConstants.BROWSER_CHROME_URL,
      "_blank", features, firstTab);

    if (tabsToMove.length) {
      newWindow.addEventListener(
        "before-initial-tab-adopted",
        () => {
          this.swapTabs(newWindow, tabsToMove);
        },
        {once: true}
      );
    }
  },

  concatTabsAndMerge(aTargetWindow, aWindows) {
    let tabsToMove = [];
    for (let i = 0; i < aWindows.length; i++)
      tabsToMove = tabsToMove.concat(Array.prototype.slice.call(aWindows[i].gBrowser.tabs));
    this.swapTabs(aTargetWindow, tabsToMove);
  },

  // tabs from popup windows open after opener or at the end
  // other tabs open according to our openTabNext preference
  // and move to place by tabbrowser.addTab
  moveTabsFromPopups(tab, openerID, tabbrowser) {
    if (!tabbrowser) {
      tabbrowser = tab.__tabmixTabBrowser;
      delete tab.__tabmixTabBrowser;
    }
    let index = tabbrowser.tabs.length;
    let openerTab;
    if (openerID) {
      // since we merge popup after all other tabs was merged,
      // we only look for opener in the target window
      const openerBrowser = tabbrowser.getBrowserForOuterWindowID(openerID);
      openerTab = tabbrowser.getTabForBrowser(openerBrowser);
      if (openerTab)
        index = openerTab._tPos + 1;
    }

    const promise = tab._tabmix_movepopup_promise;
    delete tab._tabmix_movepopup_promise;
    const tabToSelect = tab.hasAttribute("_TMP_selectAfterMerge");
    const newTab = tabbrowser.adoptTab(tab, index, false);
    if (openerTab) {
      newTab.owner = openerTab;
    }
    promise.resolve(tabToSelect ? newTab : null);
  },

  // move tabs to a window
  async swapTabs(aWindow, tabs) {
    var currentWindow = TabmixSvc.topWin();
    var notFocused = currentWindow != aWindow;
    if (notFocused) {
      // after merge select currently selected tab or first merged tab
      let selectedTab = currentWindow.gBrowser.selectedTab;
      let tab = tabs.indexOf(selectedTab) > -1 ? selectedTab : tabs[0];
      tab.setAttribute("_TMP_selectAfterMerge", true);
    }

    var tabbrowser = aWindow.gBrowser;
    var placePopupNextToOpener = this.prefs.getBoolPref("placePopupNextToOpener");
    var tabToSelect = null;
    let newIndex = Services.prefs.getBoolPref("browser.tabs.insertAfterCurrent") ?
      tabbrowser.selectedTab._tPos + 1 : tabbrowser.tabs.length;
    const popups = [];

    for (let i = 0; i < tabs.length; i++) {
      let tab = tabs[i];
      let isPopup = !tab.ownerGlobal.toolbar.visible;
      if (isPopup) {
        popups.push(tab);
      } else {
        let newTab = tabbrowser.adoptTab(tab, newIndex, false);
        if (tab.hasAttribute("_TMP_selectAfterMerge")) {
          tab.removeAttribute("_TMP_selectAfterMerge");
          tabToSelect = newTab;
        }
        newIndex++;
      }
    }

    const max_windows_undo = Services.prefs.getIntPref("browser.sessionstore.max_windows_undo");
    const closedWindowCount = aWindow.SessionStore.getClosedWindowCount();
    const tempMax = Math.max(max_windows_undo, closedWindowCount + popups.length);
    Services.prefs.setIntPref("browser.sessionstore.max_windows_undo", tempMax);

    const promises = [Promise.resolve(tabToSelect)];
    for (const tab of popups) {
      const deferred = TabmixSvc.version(1230) ? Promise.withResolvers() : lazy.PromiseUtils.defer();
      promises.push(deferred.promise);
      tab._tabmix_movepopup_promise = deferred;

      let openerWindowID, waitToMessage;
      if (placePopupNextToOpener) {
        let browser = tab.linkedBrowser;
        openerWindowID = browser.browsingContext?.opener?.currentWindowGlobal?.outerWindowId;
        if (!openerWindowID && browser.getAttribute("remote") == "true") {
          tab.__tabmixTabBrowser = tabbrowser;
          browser.messageManager.sendAsyncMessage("Tabmix:collectOpener");
          waitToMessage = true;
        }
      }
      if (!waitToMessage) {
        this.moveTabsFromPopups(tab, openerWindowID, tabbrowser);
      }
    }

    tabToSelect = (await Promise.all(promises)).filter(t => t)[0];

    if (popups.length) {
      // wait until sessionStore finish saveing closed windows data
      await TabmixSvc.SessionStore._handleClosedWindows();
      while (aWindow.SessionStore.getClosedWindowCount() > closedWindowCount) {
        aWindow.SessionStore.forgetClosedWindow(0);
      }
      Services.prefs.setIntPref("browser.sessionstore.max_windows_undo", max_windows_undo);
    }

    if (notFocused) {
      // select new tab after all other tabs swap to the target window
      if (tabToSelect)
        tabbrowser.selectedTab = tabToSelect;
      aWindow.focus();
    }
  },

  isPopupWindow(aWindow) {
    return !aWindow.toolbar.visible;
  },

  isWindowPrivate(aWindow) {
    return lazy.PrivateBrowsingUtils.isWindowPrivate(aWindow);
  },

  /*
   * Get windows that match the most search in recent order (ZOrder).
   *
   * @param aWindow a window to skip.
   *
   * @param aOptions an object accepting the arguments for the search.
   *        Set the private property to true in order to restrict the
   *        search to private windows only, or to false in order to
   *        restrict the search to non-private windows only.  To search
   *        in both groups, don't specify the private property.
   *
   *        set skipPopup property to true when the preference is not
   *        to merge popups.
   *
   *        set multiple property to true to get all suitable windows
   *
   * @return
   *        multiple is true all non-popup windows then all popup windows
   *        multiple is false most recent non-popup windows or most recent
   *        popup windows
   */
  getWindowsList(aWindow, aOptions) {
    let checkPrivacy = typeof aOptions == "object" &&
                       "private" in aOptions;

    let privateNotMatch = 0;
    let isSuitableBrowserWindow = win => {
      let suitable = win != aWindow && !win.closed;
      if (!suitable || !checkPrivacy)
        return suitable;

      if (this.isWindowPrivate(win) == aOptions.private)
        return true;
      privateNotMatch++;
      return false;
    };

    let windows = [], popUps = [];
    const windowList = lazy.BrowserWindowTracker.orderedWindows;
    for (const nextWin of windowList) {
      if (isSuitableBrowserWindow(nextWin)) {
        if (this.isPopupWindow(nextWin))
          popUps.push(nextWin);
        else
          windows.push(nextWin);
      }
      if (!aOptions.multiple && windows.length) {
        break;
      }
    }

    aOptions.privateNotMatch = privateNotMatch > 0;
    if (aOptions.skipPopup)
      popUps = [];

    let normalWindowsCount = windows.length;
    if (aOptions.multiple)
      return {windows: windows.concat(popUps), normalWindowsCount};

    let target = windows[0] || popUps[0] || null;
    return {windows: target ? [target] : [], normalWindowsCount};
  },

  notify: function TMP_mergeNotify(aWindow, privateNotMatch) {
    let errorMessage = TabmixSvc.getString('tmp.merge.error');
    if (privateNotMatch)
      errorMessage += ", " + TabmixSvc.getString('tmp.merge.private');
    let notificationBox = aWindow.gBrowser.getNotificationBox();
    let name = "mergeWindows-notification";
    if (!notificationBox.getNotificationWithValue(name)) {
      const priority = notificationBox.PRIORITY_INFO_MEDIUM;
      const notificationBar = notificationBox.appendNotification(
        name,
        {
          label: errorMessage,
          priority,
        }
      );
      aWindow.setTimeout(() => {
        notificationBox.removeNotification(notificationBar);
      }, 10000);
    }
  },

  warnBeforeClosingWindow(aWindow) {
    // prompt a warning before closing a window with left over tabs
    var canClose = this.prefs.getBoolPref("closeOnSelect");
    if (!canClose)
      return false;

    var shouldPrompt = this.prefs.getBoolPref("warnOnclose");
    if (!shouldPrompt)
      return true;

    var promptAgain = {value: true};
    canClose = Services.prompt.confirmCheck(aWindow,
      TabmixSvc.getString('tmp.merge.warning.title'),
      TabmixSvc.getString('tmp.merge.warning.message'),
      TabmixSvc.getString('tmp.merge.warning.checkbox'),
      promptAgain);

    if (canClose && !promptAgain.value)
      this.prefs.setBoolPref("warnOnClose", false);

    return canClose;
  }
};
