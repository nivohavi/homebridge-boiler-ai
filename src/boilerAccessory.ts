import { Service, PlatformAccessory, CharacteristicValue, Logger } from 'homebridge';
import { BoilerAIPlatform } from './platform';

export class BoilerAccessory {
  private service: Service;

  constructor(
    private readonly platform: BoilerAIPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly log: Logger,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Boiler AI')
      .setCharacteristic(this.platform.Characteristic.Model, 'Solar Hot Water Controller')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'BOILER-AI-001');

    this.service = this.accessory.getService(this.platform.Service.Switch)
      || this.accessory.addService(this.platform.Service.Switch, 'Boiler AI');

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));
  }

  async getOn(): Promise<CharacteristicValue> {
    return this.platform.isBoilerOn();
  }

  async setOn(value: CharacteristicValue): Promise<void> {
    if (value) {
      this.log.info('HomeKit: triggering AI decision cycle');
      this.platform.triggerDecisionCycle('homekit');
    } else {
      this.log.info('HomeKit: emergency stop');
      await this.platform.stopBoiler();
    }
  }

  updateState(on: boolean): void {
    this.service.updateCharacteristic(this.platform.Characteristic.On, on);
  }
}
