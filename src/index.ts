import { API } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { BoilerAIPlatform } from './platform';

export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, BoilerAIPlatform);
};
