'use strict';
// Hand-written fault texts ("<address>:<code>"; "*:<code>" for any unit, when the text itself says
// which unit stores it), for faults seen on real cars. They are not BMW's texts: shown only when
// neither the fault text database (dtc_db/) nor the car's own export (dtc_texts.js) has a text for
// the fault, and then marked "Hand-written:" (texts.js).
// Plain ASCII: drawn with the app's baked fonts.
module.exports = {
    '12:CDBA3B': 'FA-CAN message missing: fuel tank level / range (0x373)',
    '63:B7F8E5': 'Debug mode active (SSH open)',
    '63:B7F8F9': 'HU-H: Reset',
    '*:D16DEC': 'Message (driver assistance, comfort, safety) missing, receiver ACC/FRSF, transmitter DSC/SAS',
    '*:D16E01': 'Message (chassis, acceleration data) missing, receiver ACC/FRSF, transmitter DSC/VIP',
};
