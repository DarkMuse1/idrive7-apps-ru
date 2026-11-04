module.exports={
  "ecu": 7,
  "soc": [
    {
      "did": "DDBC",
      "bytes": 2,
      "at": 0,
      "factor": 0.1,
      "offset": 0,
      "min": 0,
      "max": 100
    }
  ],
  "soh": [
    {
      "did": "DD7B",
      "bytes": 1,
      "at": 0,
      "factor": 1,
      "offset": 0,
      "min": 40,
      "max": 110
    },
    {
      "did": "6335",
      "bytes": 1,
      "at": 0,
      "factor": 1,
      "offset": 0,
      "min": 40,
      "max": 110
    }
  ],
  "v12": [
    {
      "ecu": 18,
      "did": "F442",
      "bytes": 2,
      "at": 0,
      "factor": 0.001,
      "offset": 0,
      "min": 5,
      "max": 18
    },
    {
      "ecu": 7,
      "did": "F442",
      "bytes": 2,
      "at": 0,
      "factor": 0.001,
      "offset": 0,
      "min": 5,
      "max": 18
    },
    {
      "ecu": 18,
      "obd": "42",
      "bytes": 2,
      "at": 0,
      "factor": 0.001,
      "offset": 0,
      "min": 5,
      "max": 18,
      "note": "the same PID with OBD service 01, for engine units that refuse F442 with NRC 31"
    },
    {
      "ecu": 19,
      "did": "F442",
      "bytes": 2,
      "at": 0,
      "factor": 0.001,
      "offset": 0,
      "min": 5,
      "max": 18,
      "note": "second engine unit (0x13), on cars that have one"
    },
    {
      "ecu": 19,
      "obd": "42",
      "bytes": 2,
      "at": 0,
      "factor": 0.001,
      "offset": 0,
      "min": 5,
      "max": 18
    },
    {
      "ecu": 24,
      "did": "F442",
      "bytes": 2,
      "at": 0,
      "factor": 0.001,
      "offset": 0,
      "min": 5,
      "max": 18,
      "note": "transmission unit EGS (0x18): control module voltage too, when the engine unit doesn't answer (e.g. G06 N63)"
    },
    {
      "ecu": 24,
      "obd": "42",
      "bytes": 2,
      "at": 0,
      "factor": 0.001,
      "offset": 0,
      "min": 5,
      "max": 18
    }
  ],
  "chargeMinPct": 3,
  "powerSign": -1,
  "fast": {
    "hvV": [
      {
        "did": "DDB4",
        "fields": {
          "v": {
            "bytes": 2,
            "factor": 0.01,
            "min": 150,
            "max": 500
          }
        },
        "note": "confirmed on the X5 45e"
      },
      {
        "did": "DD68",
        "fields": {
          "v": {
            "bytes": 2,
            "factor": 0.01,
            "min": 150,
            "max": 500
          }
        }
      },
      {
        "did": "DD66",
        "fields": {
          "v": {
            "bytes": 2,
            "factor": 0.01,
            "min": 150,
            "max": 500
          }
        }
      },
      {
        "did": "DDEF",
        "fields": {
          "v": {
            "bytes": 2,
            "factor": 1,
            "min": 150,
            "max": 500
          }
        }
      }
    ],
    "hvI": [
      {
        "did": "DD69",
        "fields": {
          "a": {
            "bytes": 4,
            "factor": 0.01,
            "signed": true,
            "min": -800,
            "max": 800
          }
        }
      }
    ]
  },
  "slow": {
    "soc": [
      {
        "did": "DDBC",
        "fields": {
          "pct": {
            "bytes": 2,
            "factor": 0.1,
            "min": 0,
            "max": 100
          }
        }
      }
    ],
    "cellV": [
      {
        "did": "DFA5",
        "array": {
          "bytes": 2,
          "factor": 0.001,
          "min": 2.5,
          "max": 4.4
        },
        "note": "every cell's voltage, 2 bytes each (96 on the X5 45e): found with the Scan page"
      },
      {
        "did": "DDBF",
        "fields": {
          "min": {
            "at": 0,
            "bytes": 2,
            "factor": 0.001,
            "min": 2.5,
            "max": 4.4
          },
          "max": {
            "at": 2,
            "bytes": 2,
            "factor": 0.001,
            "min": 2.5,
            "max": 4.4
          }
        }
      }
    ],
    "cellT": [
      {
        "did": "DDC0",
        "fields": {
          "min": {
            "at": 0,
            "bytes": 2,
            "factor": 0.01,
            "signed": true,
            "min": -40,
            "max": 80
          },
          "max": {
            "at": 2,
            "bytes": 2,
            "factor": 0.01,
            "signed": true,
            "min": -40,
            "max": 80
          },
          "avg": {
            "at": 4,
            "bytes": 2,
            "factor": 0.01,
            "signed": true,
            "min": -40,
            "max": 80
          }
        }
      }
    ],
    "coolant": [
      {
        "did": "DD6C",
        "fields": {
          "t": {
            "bytes": 2,
            "factor": 0.01,
            "signed": true,
            "min": -40,
            "max": 100
          }
        }
      }
    ],
    "limits": [
      {
        "did": "DD7D",
        "fields": {
          "chargeA": {
            "at": 0,
            "bytes": 2,
            "factor": 0.1,
            "min": 0,
            "max": 1000
          },
          "dischargeA": {
            "at": 2,
            "bytes": 2,
            "factor": 0.1,
            "min": 0,
            "max": 1000
          }
        }
      }
    ]
  }
};
