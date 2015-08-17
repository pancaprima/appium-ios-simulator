import path from 'path';
import * as simctl from 'node-simctl';
import log from './logger';
import { fs, util } from 'appium-support';
import B from 'bluebird';
import _ from 'lodash';
import { utils as instrumentsUtil } from 'appium-instruments';
import { killAllSimulators } from './utils.js';
import _glob from 'glob';
import { read } from './settings';
import { asyncMap } from 'asyncbox';
import * as settings from './settings';


const glob = B.promisify(_glob);


class SimulatorXcode6 {
  constructor (udid, xcodeVersion) {
    this.udid = String(udid);
    this.xcodeVersion = xcodeVersion;

    // platformVersion cannot be found initially, since getting it has side effects for
    // our logic for figuring out if a sim has been run
    // it will be set when it is needed
    this._platformVersion = null;

    //TODO assert that udid is a valid sim
    this.keychainPath = path.resolve(this.getDir(), 'Library', 'Keychains');

    this.appDataBundlePaths = null;
  }

  //TODO default constructor with no args should create a sim with some defaults

  async getPlatformVersion () {
    if (!this._platformVersion) {
      let {sdk} = await this.stat();
      this._platformVersion = sdk;
    }
    return this._platformVersion;
  }

  getRootDir () {
    let home = process.env.HOME;
    return path.resolve(home, 'Library', 'Developer', 'CoreSimulator', 'Devices');
  }

  getDir () {
    return path.resolve(this.getRootDir(), this.udid, 'data');
  }

  getLogDir () {
    return path.resolve(this.getDir(), 'Library', 'Logs');
  }

  /*
   * takes an `id`, which is either a bundleId (e.g., com.apple.mobilesafari)
   * or, for iOS 7.1, the app name without `.app` (e.g., MobileSafari)
   */
  async getAppDataDir (id) {
    if (await this.isFresh()) {
      log.info('Attempted to get an app path from a fresh simulator ' +
               'quickly launching the sim to populate its directories');
      await this.launchAndQuit();
    }

    if (this.appDataBundlePaths === null) {
      this.appDataBundlePaths = await this.buildBundlePathMap();
    }
    return this.appDataBundlePaths[id];
  }

  /*
   * the xcode 6 simulators are really annoying, and bury the main app
   * directories inside directories just named with Hashes.
   * This function finds the proper directory by traversing all of them
   * and reading a metadata plist (Mobile Container Manager) to get the
   * bundle id.
   */
  async buildBundlePathMap () {
    let applicationList;
    let pathBundlePair;

    if (await this.getPlatformVersion() === '7.1') {
      // apps available
      //   Web.app,
      //   WebViewService.app,
      //   MobileSafari.app,
      //   WebContentAnalysisUI.app,
      //   DDActionsService.app,
      //   StoreKitUIService.app
      applicationList = path.resolve(this.getDir(), 'Applications');
      pathBundlePair = async (dir) => {
        dir = path.resolve(applicationList, dir);
        let appFiles = await glob(`${dir}/*.app`);
        let bundleId = appFiles[0].match(/.*\/(.*)\.app/)[1];
        return {path: dir, bundleId};
      };
    } else {
      applicationList = path.resolve(this.getDir(), 'Containers', 'Data', 'Application');
      // given a directory, find the plist file and pull the bundle id from it
      let readBundleId = async (dir) => {
        let plist = path.resolve(dir, '.com.apple.mobile_container_manager.metadata.plist');
        let metadata = await read(plist);
        return metadata[0].MCMMetadataIdentifier;
      };
      // given a directory, return the path and bundle id associated with it
      pathBundlePair = async (dir) => {
        dir = path.resolve(applicationList, dir);
        return {path: dir, bundleId: await readBundleId(dir)};
      };
    }

    let bundlePathPairs = await fs.readdir(applicationList).map(pathBundlePair).then((pairs) => {
      // reduce the list of path-bundle pairs to an object where bundleIds are mapped to paths
      return pairs.reduce((bundleMap, bundlePath) => {
        bundleMap[bundlePath.bundleId] = bundlePath.path;
        return bundleMap;
      }, {});
    });
    return bundlePathPairs;
  }

  // returns state and specifics of this sim.
  // { name: 'iPhone 4s',
  //   udid: 'C09B34E5-7DCB-442E-B79C-AB6BC0357417',
  //   state: 'Shutdown',
  //   sdk: '8.3'
  // }
  async stat () {
    let devices = await simctl.getDevices();
    let normalizedDevices = [];

    // add sdk attribute to all entries, add to normalizedDevices
    for (let [sdk, deviceArr] of _.pairs(devices)) {
      deviceArr = deviceArr.map((device) => {
        device.sdk = sdk;
        return device;
      });
      normalizedDevices = normalizedDevices.concat(deviceArr);
    }

    return _.findWhere(normalizedDevices, {udid: this.udid});
  }

  async isFresh () {
    // this is a best-bet heuristic for whether or not a sim has been booted
    // before. We usually want to start a simulator to "warm" it up, have
    // Xcode populate it with plists for us to manipulate before a real
    // test run.

    // if the following files don't exist, it hasn't been booted.
    // THIS IS NOT AN EXHAUSTIVE LIST

    let files = [
      'Library/ConfigurationProfiles',
      'Library/Cookies',
      'Library/Logs',
      'Library/Preferences/.GlobalPreferences.plist',
      'Library/Preferences/com.apple.springboard.plist',
      'var/run/syslog.pid'
    ];
    if (await this.getPlatformVersion() !== '7.1') {
      files.push('Library/DeviceRegistry.state');
      files.push('Library/Preferences/com.apple.Preferences.plist');
    } else {
      files.push('Applications');
    }

    files = files.map((s) => {
      return path.resolve(this.getDir(), s);
    });

    let existence = await asyncMap(files.map, async (f) => { return util.hasAccess(f); });

    existence = await B.all(existence); // will throw an error if an fs.stat call fails

    return _.compact(existence).length !== files.length;
  }

  // setLocale (language, locale, calendarFormat) {
  //
  // }
  //
  // setPreferences () {
  //
  // }
  //
  // setLocationPreferences () {
  //
  // }
  //
  // setSafariPreferences () {
  //
  // }

  // TODO keep keychains
  async clean () {
    log.info(`Cleaning simulator ${this.udid}`);
    await simctl.eraseDevice(this.udid);
  }

  async launchAndQuit () {
    // launch
    await instrumentsUtil.quickLaunch(this.udid);

    // wait for the system to create the files we will manipulate
    // need quite a high retry number, in order to accommodate iOS 7.1
    // locally, 7.1 averages 8.5 retries (from 6 - 12)
    //          8+ averages 0.6 retries (from 0 - 2)
    const RETRIES = 15;
    let retry;
    for (retry = 0; retry < RETRIES; retry++) {
      if (await this.isFresh()) {
        if (retry < RETRIES - 1) {
          log.debug('Simulator files not fully created. Waiting a bit');
          await B.delay(250);
        } else {
          log.error('Simulator files never fully created. Proceeding, but problems may ensue');
        }
      } else {
        break;
      }
    }

    // and quit
    await this.shutdown();
    await killAllSimulators();
  }

  async shutdown () {
    await simctl.shutdown(this.udid);
  }

  async delete () {
    await simctl.deleteDevice(this.udid);
  }

  //cleanCustomApp? - probably not needed, we just use simctl erase to clean

  async updateLocationSettings (bundleId, authorized) {
    return settings.updateLocationSettings(this, bundleId, authorized);
  }

  //updateSettings
  //updateSafariSettings


}

export default SimulatorXcode6;