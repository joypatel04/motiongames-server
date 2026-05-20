/**
 * Compute an 8-bit byte-sum checksum: sum all bytes modulo 256.
 */
export function byteSum(bytes: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < bytes.length; i++) {
    s = (s + (bytes[i] ?? 0)) & 0xff;
  }
  return s;
}

/**
 * XOR checksum across the input bytes.
 */
export function xorChecksum(bytes: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < bytes.length; i++) {
    s = (s ^ (bytes[i] ?? 0)) & 0xff;
  }
  return s;
}

/**
 * CRC-16/MODBUS (poly 0xA001, init 0xFFFF). Returned little-endian friendly value.
 */
export function crc16Modbus(bytes: ArrayLike<number>): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] ?? 0;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x0001) !== 0) {
        crc = (crc >>> 1) ^ 0xa001;
      } else {
        crc = crc >>> 1;
      }
    }
  }
  return crc & 0xffff;
}
