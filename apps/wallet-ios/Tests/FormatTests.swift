import XCTest
import BigInt
@testable import EticaHubWallet

final class FormatTests: XCTestCase {
    func testParseAndFormatRoundTrip() {
        let wei = Format.parse("1.5", decimals: 18)!
        XCTAssertEqual(wei, BigUInt("1500000000000000000"))
        XCTAssertEqual(Format.amount(wei, decimals: 18), "1.5")
        XCTAssertEqual(Format.parse("0.000001", decimals: 6), BigUInt(1))
        XCTAssertNil(Format.parse("1.2345678", decimals: 6))
        XCTAssertNil(Format.parse("abc", decimals: 18))
    }

    func testHubPath() {
        XCTAssertEqual(Token.path(from: .egaz, to: .eti), [Chain.wegaz, Chain.etx, Token.eti.address!])
        XCTAssertEqual(Token.path(from: .etx, to: .usdce), [Chain.etx, Token.usdce.address!])
    }
}
