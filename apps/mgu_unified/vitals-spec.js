module.exports={
  "dme": {
    "comment": "Intake / fuel values from the engine unit (DME, ecu 18 = 0x12) with UDS 0x22. F4xx = the standard OBD PIDs (F40F = PID 0x0F); a candidate with \"obd\" instead of \"did\" asks for the same PID with OBD service 01 (some engine units refuse the F4xx identifiers with NRC 31). Candidates are tried in order; the first plausible one wins. value = raw * factor + offset (bar / deg C). If a tile says 'not available from this DME', add your engine's BMW-specific DID here. boost: tried in order when the sport display sends no boost (setting 'Boost from'); absolute pressure in kPa, the outside air pressure (baro) is subtracted. boostTarget / boostActual: boost pressure setpoint and actual (absolute kPa, baro subtracted), BMW DIDs first, then OBD PID 0x70; the tile only shows when the target answers. loadTarget / loadActual: requested and actual relative air charge in %. timing: OBD PID 0x0E, degrees before top dead centre. misfire: OBD service 06 monitor results (MID A2 = cylinder 1, A3 = cylinder 2 ...), tid 0C = misfires this driving cycle (0B = average of the last 10 cycles); engine units that only speak UDS are asked 0x22 F6A2... egs: gearbox temperature from the gearbox unit (EGS); give each candidate its \"ecu\".",
    "ecu": 18,
    "iat": [
      {
        "did": "F40F",
        "bytes": 1,
        "at": 0,
        "factor": 1,
        "offset": -40,
        "min": -40,
        "max": 150
      },
      {
        "did": "F477",
        "bytes": 1,
        "at": 1,
        "factor": 1,
        "offset": -40,
        "min": -40,
        "max": 150,
        "note": "charge air cooler temperature, bank 1 sensor 1"
      },
      {
        "obd": "0F",
        "bytes": 1,
        "at": 0,
        "factor": 1,
        "offset": -40,
        "min": -40,
        "max": 150,
        "note": "the same PID with OBD service 01, for engine units that refuse F40F with NRC 31"
      }
    ],
    "hpfp": [
      {
        "did": "F423",
        "bytes": 2,
        "at": 0,
        "factor": 0.1,
        "offset": 0,
        "min": 0,
        "max": 500,
        "note": "fuel rail gauge pressure (direct injection), 10 kPa per bit"
      },
      {
        "did": "F459",
        "bytes": 2,
        "at": 0,
        "factor": 0.1,
        "offset": -1,
        "min": 0,
        "max": 500,
        "note": "fuel rail absolute pressure, 10 kPa per bit"
      },
      {
        "obd": "23",
        "bytes": 2,
        "at": 0,
        "factor": 0.1,
        "offset": 0,
        "min": 0,
        "max": 500,
        "note": "OBD service 01 PID 0x23 (same as F423)"
      }
    ],
    "lpfp": [
      {
        "did": "F40A",
        "bytes": 1,
        "at": 0,
        "factor": 0.03,
        "offset": 0,
        "min": 0.5,
        "max": 8,
        "note": "fuel pressure (gauge), 3 kPa per bit"
      },
      {
        "did": "F422",
        "bytes": 2,
        "at": 0,
        "factor": 0.00079,
        "offset": 0,
        "min": 0.5,
        "max": 15,
        "note": "fuel rail pressure relative to manifold, 0.079 kPa per bit"
      },
      {
        "obd": "0A",
        "bytes": 1,
        "at": 0,
        "factor": 0.03,
        "offset": 0,
        "min": 0.5,
        "max": 8,
        "note": "OBD service 01 PID 0x0A (same as F40A)"
      },
      {
        "obd": "22",
        "bytes": 2,
        "at": 0,
        "factor": 0.00079,
        "offset": 0,
        "min": 0.5,
        "max": 15,
        "note": "OBD service 01 PID 0x22 (same as F422)"
      }
    ],
    "oil": [
      {
        "obd": "5C",
        "bytes": 1,
        "at": 0,
        "factor": 1,
        "offset": -40,
        "min": -40,
        "max": 170,
        "note": "engine oil temperature, OBD service 01 PID 0x5C - only read while the car's own signal (CDS) sends none"
      },
      {
        "did": "F45C",
        "bytes": 1,
        "at": 0,
        "factor": 1,
        "offset": -40,
        "min": -40,
        "max": 170
      }
    ],
    "boost": [
      {
        "did": "F470",
        "bytes": 2,
        "at": 3,
        "factor": 0.03125,
        "offset": 0,
        "min": 20,
        "max": 600,
        "note": "OBD PID 0x70 boost pressure control: actual boost pressure sensor A (absolute), 1/32 kPa"
      },
      {
        "did": "F487",
        "bytes": 2,
        "at": 1,
        "factor": 0.03125,
        "offset": 0,
        "min": 20,
        "max": 600,
        "note": "OBD PID 0x87 intake manifold absolute pressure sensor A, 1/32 kPa"
      },
      {
        "did": "F40B",
        "bytes": 1,
        "at": 0,
        "factor": 1,
        "offset": 0,
        "min": 20,
        "max": 255,
        "note": "OBD PID 0x0B intake manifold absolute pressure, kPa (max 255 = 1.5 bar boost)"
      },
      {
        "obd": "0B",
        "bytes": 1,
        "at": 0,
        "factor": 1,
        "offset": 0,
        "min": 20,
        "max": 255,
        "note": "OBD service 01 PID 0x0B (same as F40B)"
      }
    ],
    "baro": [
      {
        "did": "F433",
        "bytes": 1,
        "at": 0,
        "factor": 1,
        "offset": 0,
        "min": 50,
        "max": 115,
        "note": "OBD PID 0x33 barometric pressure, kPa (101.3 when not available)"
      },
      {
        "obd": "33",
        "bytes": 1,
        "at": 0,
        "factor": 1,
        "offset": 0,
        "min": 50,
        "max": 115,
        "note": "OBD service 01 PID 0x33 (same as F433)"
      }
    ],
    "boostTarget": [
      {
        "did": "4AB0",
        "bytes": 2,
        "at": 0,
        "factor": 0.00390625,
        "offset": 0,
        "min": 20,
        "max": 400,
        "note": "BMW boost pressure setpoint (absolute), hPa = raw * 10 / 256"
      },
      {
        "did": "F470",
        "bytes": 2,
        "at": 1,
        "factor": 0.03125,
        "offset": 0,
        "min": 20,
        "max": 600,
        "note": "OBD PID 0x70: commanded boost pressure A (absolute), 1/32 kPa"
      },
      {
        "obd": "70",
        "bytes": 2,
        "at": 1,
        "factor": 0.03125,
        "offset": 0,
        "min": 20,
        "max": 600,
        "note": "OBD service 01 PID 0x70 (same as F470)"
      }
    ],
    "boostActual": [
      {
        "did": "580B",
        "bytes": 2,
        "at": 0,
        "factor": 0.00390625,
        "offset": 0,
        "min": 20,
        "max": 400,
        "note": "BMW boost pressure actual (absolute), hPa = raw * 10 / 256"
      },
      {
        "did": "F470",
        "bytes": 2,
        "at": 3,
        "factor": 0.03125,
        "offset": 0,
        "min": 20,
        "max": 600,
        "note": "OBD PID 0x70: boost pressure sensor A (absolute), 1/32 kPa"
      },
      {
        "obd": "70",
        "bytes": 2,
        "at": 3,
        "factor": 0.03125,
        "offset": 0,
        "min": 20,
        "max": 600,
        "note": "OBD service 01 PID 0x70 (same as F470)"
      }
    ],
    "loadTarget": [
      {
        "did": "480C",
        "bytes": 2,
        "at": 0,
        "factor": 0.0234375,
        "offset": 0,
        "min": 0,
        "max": 250,
        "note": "BMW requested relative air charge, % = raw * 0.75 / 32"
      }
    ],
    "loadActual": [
      {
        "did": "5813",
        "bytes": 1,
        "at": 0,
        "factor": 0.75,
        "offset": 0,
        "min": 0,
        "max": 191.25,
        "note": "BMW actual relative air charge, % = raw * 0.75"
      }
    ],
    "timing": [
      {
        "obd": "0E",
        "bytes": 1,
        "at": 0,
        "factor": 0.5,
        "offset": -64,
        "min": -64,
        "max": 63.5,
        "note": "OBD service 01 PID 0x0E timing advance, degrees before TDC (cylinder 1)"
      },
      {
        "did": "F40E",
        "bytes": 1,
        "at": 0,
        "factor": 0.5,
        "offset": -64,
        "min": -64,
        "max": 63.5,
        "note": "the same PID over UDS 0x22"
      }
    ],
    "misfire": {
      "tid": "0C",
      "note": "set to {} to switch off; \"ecu\" to ask another unit"
    },
    "egs": [
      {
        "ecu": 24,
        "did": "6000",
        "bytes": 1,
        "at": 0,
        "factor": 1,
        "offset": -40,
        "min": -40,
        "max": 160,
        "note": "ZF 8HP (GSZFBCE) _GETRIEBEOELTEMPERATUR, deg C + 40 (idrive7-apps PR #29, read on a G22)"
      },
      {
        "ecu": 24,
        "did": "DA12",
        "bytes": 1,
        "at": 0,
        "factor": 1,
        "offset": -48,
        "min": -40,
        "max": 160,
        "note": "gearbox unit (EGS, 0x18) transmission oil temperature, deg C + 48 (from a forum report, not confirmed on a car: only shown once it changes; the replies go to the log, \"raw EGS\")"
      }
    ]
  },
  "xdrive": {
    "comment": "xDrive split straight from the transfer case unit (LMV, address 0x19), read on the Chassis page when the car's own split signal has nothing. LMV_MOMENT (22 DB32): actual torque to the front axle, signed, Nm = raw / 4 (bytes 0-1); qualifier bytes 2-3, target torque 4-5 (layout from BMW's LMV_G11 description). Split % = front torque / (engine torque x gear ratio): an estimate (no converter multiplication, no losses).",
    "front": [
      {
        "ecu": 25,
        "did": "DB32",
        "bytes": 2,
        "at": 0,
        "factor": 0.25,
        "signed": true,
        "min": -200,
        "max": 2500,
        "note": "LMV_MOMENT.ISTMOMENT, actual torque to the front axle"
      }
    ],
    "gearRatios": [
      5.0,
      3.2,
      2.143,
      1.72,
      1.313,
      1.0,
      0.823,
      0.64
    ],
    "gearRatiosNote": "ZF 8HP, 1st..8th"
  }
};
