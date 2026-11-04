module.exports={
  "signals": {
    "de.bmw.infotainment.controlelements.FrontCCU": {
      "statusRotaryEncoderState": "rs"
    },
    "de.bmw.infotainment.climate.climatemaster.ClimateMaster": {
      "statusClimateSystemOn": "rs",
      "statusAirCondAC": "rs"
    },
    "de.bmw.infotainment.climate.Climate2": {
      "statusACFront": "rs",
      "statusAirConditionDRStatus": "rs"
    },
    "de.bmw.infotainment.climate.Climate": {
      "statusSeatHeatingDR": "rs",
      "statusSeatHeatingPS": "rs",
      "statusSeatHeatingDRR": "rs",
      "statusSeatHeatingPSR": "rs"
    },
    "de.bmw.body.steeringwheelcomfort.SteeringWheelClimate": {
      "heatingState": "rs"
    },
    "com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu": {
      "_instances": "SystemFunctionsInternalTasuInst1",
      "_methods": [
        "sendTasuRequest"
      ],
      "_broadcasts": [
        "sendTasuResponse"
      ]
    },
    "de.bmw.infotainment.checkcontrol.CheckControlMaster": {
      "basicList": "rs"
    },
    "de.bmw.infotainment.misc.ComfortFunctionIuK": {
      "_instances": "1",
      "statusAmbientLightInteriorColour": "rs",
      "ambientLightInteriorColour": "w"
    },
    "de.bmw.infotainment.KombiInterface_2": {
      "cbsDataServiceList": "rs",
      "cbsDataSBA": "rs",
      "_methods": [
        "requestCBSServiceHint"
      ]
    },
    "de.bmw.infotainment.vehicle.CDS": {
      "statusEngineSpeed2": "rs",
      "statusEngineTemperature": "rs",
      "statusEngineStatus": "rs",
      "datenFahrdynamiksensorErweitert": "rs",
      "statusHandBrake": "rs",
      "statusBattery2": "rs"
    },
    "de.bmw.infotainment.vehicle.Vehicle2": {
      "statusCarSpeed2": "rs",
      "statusOilDipstick2": "rs",
      "statusVehicleMass": "rs",
      "statusVehiclePartType": "rs"
    },
    "de.bmw.infotainment.vehicle.Vehicle": {
      "statusNewCurrentUnitsStatusExt": "rs"
    },
    "de.bmw.infrastructure.VehicleInformation": {
      "statusGearboxDrive": "s",
      "DataPowerTrain2": "s",
      "Range": "s"
    },
    "de.bmw.infotainment.vehicle.CDS2": {
      "statusLongitudinalAccelerationMassCenter": "rs",
      "statusLateralAccelerationMassCenter": "rs",
      "statusInjectionVolume": "rs",
      "statusPushButtonMSA2": "rs",
      "statusYawVelocityVehicle": "rs"
    },
    "de.bmw.infotainment.drivingexcitement.FES": {
      "statusActualValueTorque2": "rs",
      "statusSwitchDriveDynamicSport2": "rs",
      "statusVehicleDynamicEngine": "rs",
      "statusVehicleDynamicEngineMaxValue": "rs",
      "statusFESVehicleDynamicSwitchHMI": "rs"
    },
    "de.bmw.infrastructure.EnvironmentalInformation": {
      "ExteriorTemperature": "s"
    },
    "de.bmw.infrastructure.analytics.BasicDataSet": {
      "basicDataSet": "s"
    },
    "de.bmw.infotainment.vehicle.TPMS": {
      "statusTyreTemperature": "rs",
      "statusTyrePressure": "rs",
      "statusTargetTyrePressure": "rs"
    },
    "de.bmw.powertrain.AcceleratorPedal": {
      "AngleAcceleratorPedal": "s"
    },
    "de.bmw.infotainment.KombiIF": {
      "statusRangeTankStatus": "rs",
      "statusBordcomputerAverage": "rs",
      "statusBordcomputerTravelData": "rs"
    },
    "de.bmw.chassis.SteeringAngle": {
      "ActualSteeringAngleDriver": "s",
      "actualSteeringAngleDriverNoCRC": "s"
    },
    "de.bmw.powertrain.Powertrain": {
      "ActualValueRPMWheel": "s"
    },
    "de.bmw.chassis.VehicleModel": {
      "LaneSlope": "s",
      "MassVehicle": "s"
    },
    "de.bmw.chassis.VehicleStabilizationManagement": {
      "StabilizationManagement": "s"
    },
    "de.bmw.infrastructure.VehicleCondition": {
      "VehicleCondition": "s"
    }
  }
};
