import {expect, test} from "@jest/globals";
import {
  toBaseUnits,
  fromBaseUnits,
  decimal,
  hex,
  safeInt,
  MAX_UINT256,
  transferCalldata,
  addressToTopic,
  topicToAddress
} from "../src/domain/amount.js";

test("exact amounts including uint256 and sub-wei rejection", () => {
  for (const [amount, decimals, expected] of [
    ["100", 6, "100000000"],
    ["0.0004", 18, "400000000000000"],
    ["0.000000000000000001", 18, "1"],
    ["1.000001", 6, "1000001"],
    ["123456789012345678.123456789012345678", 18, "123456789012345678123456789012345678"]
  ] as const) {
    expect(toBaseUnits(amount, decimals)).toBe(expected);
    expect(fromBaseUnits(expected, decimals)).toBe(amount);
  }

  for (const value of ["0", "0.000", "-1", "1e5", "01", ".5", "1,5", " 1", "1.0000001", "abc"])
    expect(() => toBaseUnits(value, 6)).toThrow();

  expect(toBaseUnits(MAX_UINT256.toString(), 0)).toBe(MAX_UINT256.toString());
  expect(() => toBaseUnits((MAX_UINT256 + 1n).toString(), 0)).toThrow();
  expect(fromBaseUnits("0", 18)).toBe("0");
  expect(fromBaseUnits("100000000", 6)).toBe("100");
  expect(decimal("0x" + "f".repeat(64))).toBe(MAX_UINT256.toString());
  expect(hex(11155111)).toBe("0xaa36a7");
  expect(() => safeInt("0x20000000000000")).toThrow();
});

test("ERC20 ABI encoding and address topics", () => {
  const address = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

  expect(transferCalldata(address, "100000000")).toBe(
    "0xa9059cbb0000000000000000000000009858effd232b4033e47d90003d41ec34ecaeda940000000000000000000000000000000000000000000000000000000005f5e100"
  );
  expect(topicToAddress(addressToTopic(address))).toBe(address.toLowerCase());
  expect(() => addressToTopic("0x123")).toThrow();
});
