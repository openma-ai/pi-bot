import XCTest
final class KeyboardTests:XCTestCase{
 func shot(_ app:XCUIApplication,_ name:String){let a=XCTAttachment(screenshot:app.screenshot());a.name=name;a.lifetime = .keepAlways;add(a)}
 func testTwoPages(){
  let app=XCUIApplication(bundleIdentifier:"dev.pibot.ionic-experiment")
  XCUIDevice.shared.orientation = .portrait
  app.launch()
  let input=app.webViews.textViews.firstMatch
  XCTAssertTrue(input.waitForExistence(timeout:15),app.debugDescription)
  let header=app.buttons["模型配置"]
  XCTAssertTrue(header.exists)
  let top=header.frame.minY
  input.tap()
  XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout:5))
  XCTAssertLessThan(abs(header.frame.minY-top),2)
  XCTAssertTrue(app.frame.intersects(app.keyboards.firstMatch.frame))
  input.typeText("layout test\nsecond line")
  shot(app,"01-chat-software-keyboard")
  header.tap()
  let keyButton=app.buttons["演示添加 API key"]
  XCTAssertTrue(keyButton.waitForExistence(timeout:5),app.debugDescription)
  keyButton.tap()
  let key=app.secureTextFields.firstMatch
  XCTAssertTrue(key.waitForExistence(timeout:5),app.debugDescription)
  key.tap();key.typeText("TEST")
  let complete=app.buttons["完成演示"]
  XCTAssertTrue(complete.isHittable,app.debugDescription)
  shot(app,"02-key-modal-keyboard")
  complete.tap()
  XCTAssertTrue(app.staticTexts["演示认证完成"].waitForExistence(timeout:5))
  shot(app,"03-model-authenticated-synthetic")
  app.buttons["返回聊天"].firstMatch.tap()
  XCTAssertTrue(input.waitForExistence(timeout:5))
  input.tap()
  shot(app,"04-chat-repeat-focus")
 }

 func testScrollMenuCancelAndLandscape(){
  let app=XCUIApplication(bundleIdentifier:"dev.pibot.ionic-experiment")
  XCUIDevice.shared.orientation = .portrait;app.launch()
  let input=app.webViews.textViews.firstMatch
  XCTAssertTrue(input.waitForExistence(timeout:15))
  let header=app.buttons["模型配置"];let y=header.frame.minY
  app.webViews.firstMatch.swipeUp()
  XCTAssertLessThan(abs(header.frame.minY-y),2)
  input.tap()
  input.typeText("中文第一行\n第二行")
  // Dismiss keyboard and await the settled composer before measuring the menu.
  app.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.3)).tap()
  let settled=expectation(for:NSPredicate { _,_ in input.frame.minY > app.frame.height*0.7 }, evaluatedWith:nil)
  wait(for:[settled],timeout:5)
  let inputTop=input.frame.minY
  app.coordinate(withNormalizedOffset:CGVector(dx:0.1,dy:input.frame.midY/app.frame.height)).tap()
  let file=app.descendants(matching:.any).matching(NSPredicate(format:"label == %@", "文件")).firstMatch
  XCTAssertTrue(file.waitForExistence(timeout:5),app.debugDescription)
  XCTAssertLessThanOrEqual(file.frame.maxY,inputTop+8)
  shot(app,"05-attachment-menu-chinese")
  app.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.2)).tap()
  header.tap();app.buttons["演示添加 API key"].tap()
  app.buttons["完成演示"].tap()
  XCTAssertTrue(app.staticTexts["只接受合成值 TEST，请勿输入真实密钥"].waitForExistence(timeout:3))
  app.buttons["取消并返回"].tap()
  XCTAssertTrue(app.staticTexts["尚未认证"].waitForExistence(timeout:3))
  app.buttons["返回聊天"].firstMatch.tap()
  XCUIDevice.shared.orientation = .landscapeLeft
  input.tap()
  XCTAssertTrue(app.buttons["模型配置"].isHittable)
  shot(app,"06-landscape-keyboard")
  XCUIDevice.shared.orientation = .portrait
 }
}
