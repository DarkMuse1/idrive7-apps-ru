"""Offline FA/SVT/NCD inventory. No transport, coding writer or vehicle access.

NCD byte validation is not a CAFD semantic decoder or a verified backup check.
Only the observed seven-byte BMW S0 identifier layout is interpreted. Addresses
are S-record addresses, never advertised as ECU memory or writable UDS DIDs.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path
import xml.etree.ElementTree as ET


def provenance(path):
    data = Path(path).read_bytes()
    return {"sha256": hashlib.sha256(data).hexdigest(), "size_bytes": len(data)}


def xml_root(path):
    data = Path(path).read_bytes()
    if len(data) > 16 * 1024 * 1024 or b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError("oversized XML or forbidden DTD/entity declaration")
    root = ET.fromstring(data)
    for node in root.iter():
        node.tag = node.tag.rsplit("}", 1)[-1]
    return root


def read_svt(path):
    root = xml_root(path)
    if root.tag != "svt":
        raise ValueError("not an SVT document")
    ecus = []
    for ecu in root.findall("./standardSVT/ecu"):
        addresses = ecu.findall("./diagnosticAddresses/diagnosticAddress")
        parts = []
        for part in ecu.findall("./standardSVK/partIdentification"):
            kind = part.findtext("processClass")
            if kind not in ("HWEL", "BTLD", "SWFL", "CAFD"):
                continue
            number = part.findtext("id", "").upper()
            versions = [part.findtext(key, "") for key in ("mainVersion", "subVersion", "patchVersion")]
            if not re.fullmatch(r"[0-9A-F]{8}", number) or not all(re.fullmatch(r"\d{1,3}", v) for v in versions):
                raise ValueError("invalid SVK identifier")
            parts.append(kind + "_" + number + "_" + "_".join(f"{int(v):03}" for v in versions))
        for addr in addresses:
            decimal = int(addr.attrib["physicalOffset"])
            hexadecimal = int(addr.attrib["physicalOffsetAsHex"], 16)
            if decimal != hexadecimal:
                raise ValueError("SVT address representations disagree")
            ecus.append({"variant": ecu.attrib["baseVariant"], "address": f"0x{decimal:02X}", "parts": parts})
    if not ecus:
        raise ValueError("SVT has no ECUs")
    return ecus


def inspect_ncd(path):
    data = Path(path).read_bytes()
    if len(data) > 16 * 1024 * 1024:
        raise ValueError("NCD too large for this offline inspector")
    lines = data.decode("ascii").splitlines()
    memory, header, record_count, declared_count = {}, None, 0, None
    widths = {"0": 2, "1": 2, "2": 3, "3": 4, "5": 2, "6": 3, "7": 4, "8": 3, "9": 2}
    for line_number, line in enumerate(lines, 1):
        if not line or not re.fullmatch(r"S[012356789][0-9A-Fa-f]+", line) or len(line[2:]) % 2:
            raise ValueError(f"bad S-record at line {line_number}")
        kind, raw = line[1], bytes.fromhex(line[2:])
        width = widths[kind]
        if len(raw) < width + 2 or raw[0] != len(raw) - 1 or sum(raw) & 255 != 255:
            raise ValueError(f"invalid length/checksum at line {line_number}")
        address, payload = int.from_bytes(raw[1:1 + width], "big"), raw[1 + width:-1]
        if kind == "0":
            if header is not None or line_number != 1 or address != 0:
                raise ValueError("unexpected S0 header")
            header = payload
        elif kind in "123":
            if declared_count is not None:
                raise ValueError("data after S-record count")
            record_count += 1
            if address + len(payload) > 1 << (8 * width):
                raise ValueError("S-record address overflow")
            for offset, value in enumerate(payload, address):
                if offset in memory:
                    raise ValueError("overlapping S-record data")
                memory[offset] = value
        elif kind in "56":
            if declared_count is not None or payload:
                raise ValueError("invalid/duplicate record count")
            declared_count = address
        else:
            if payload or line_number != len(lines):
                raise ValueError("invalid termination record")
    if header is None or not memory or declared_count is None or declared_count != record_count:
        raise ValueError("missing header/data/count or incorrect data-record count")
    # Explicitly scoped to the supplied BMW layout; do not infer arbitrary S0 metadata.
    identifier = None
    if len(header) == 7:
        identifier = "CAFD_%08X_%03d_%03d_%03d" % (int.from_bytes(header[:4], "big"), *header[4:])
    ranges = []
    for address in sorted(memory):
        if not ranges or address != ranges[-1][1] + 1:
            ranges.append([address, address])
        else:
            ranges[-1][1] = address
    filename_match = None
    if re.fullmatch(r"CAFD_[0-9A-Fa-f]{8}_\d{3}_\d{3}_\d{3}", Path(path).stem):
        filename_match = Path(path).stem.upper() == identifier
    return {
        **provenance(path), "srecord_checksums_valid": True, "data_records": record_count,
        "payload_bytes": len(memory), "srecord_ranges": [
            {"start": f"0x{a:06X}", "end_inclusive": f"0x{b:06X}", "bytes": b - a + 1} for a, b in ranges],
        "header_cafd_candidate": identifier, "filename_matches_header": filename_match,
        "semantic_decode_available": False, "color_parameters_identified": False,
        "full_backup_verified": False, "restore_supported": False,
    }


def inspect(fa, svt, ncd):
    root = xml_root(fa)
    standard = root.find(".//standardFA")
    if standard is None:
        raise ValueError("FA has no standardFA")
    ecus, coding = read_svt(svt), inspect_ncd(ncd)
    owners = [{"variant": ecu["variant"], "address": ecu["address"]} for ecu in ecus
              if coding["header_cafd_candidate"] in ecu["parts"]]
    return {
        "schema_version": 1, "mode": "offline_only", "vehicle_contacted": False,
        "fa": {**provenance(fa), "series": standard.get("series"), "type_key": standard.get("typeKey"),
               "time_criteria": standard.get("timeCriteria"),
               "sa_codes": [item.text for item in standard.findall("./saCodes/saCode")]},
        "svt": {**provenance(svt), "ecus": ecus},
        "ncd": {**coding, "svt_identifier_matches": owners},
        "limits": ["Identifiers match files only; NCD vehicle origin is not authenticated.",
                   "FA time criteria is not a measured software I-Step or production date.",
                   "Checksums detect structural corruption, not authorship or correct coding.",
                   "SVT flags do not grant diagnostic or coding access.",
                   "No color offsets, commands, access permission or restore procedure inferred."],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("fa", "svt", "ncd", "out"):
        parser.add_argument("--" + name, required=True, type=Path)
    args = parser.parse_args()
    if args.out.resolve() in {p.resolve() for p in (args.fa, args.svt, args.ncd)}:
        parser.error("output must not overwrite an input")
    try:
        report = inspect(args.fa, args.svt, args.ncd)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive create: no source or previous evidence is overwritten.
        with args.out.open("x", encoding="utf-8") as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    except (ValueError, OSError, ET.ParseError, UnicodeError) as error:
        parser.exit(1, f"inspection failed: {error}\n")
    print("Offline inventory written. No vehicle commands or color decoding performed.")


if __name__ == "__main__":
    main()
