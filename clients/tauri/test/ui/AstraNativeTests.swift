// XCTest acceptance for the isolated dev.pibot.astra-qa fixture, never the production app.
// See docs/astra-visual-refresh.md for the native build and evidence locations.
import XCTest
final class AstraTests:XCTestCase {
 func shot(_ name:String,_ app:XCUIApplication){let a=XCTAttachment(screenshot:XCUIScreen.main.screenshot());a.name=name;a.lifetime = .keepAlways;add(a)}
 func element(_ app:XCUIApplication,_ label:String)->XCUIElement {app.descendants(matching:.any).matching(NSPredicate(format:"label == %@",label)).firstMatch}
 func tap(_ app:XCUIApplication,_ label:String){let e=element(app,label);XCTAssertTrue(e.waitForExistence(timeout:5),"Missing \(label)");e.tap();Thread.sleep(forTimeInterval:0.6)}
 func testInlineConnectionRecovery() {
  continueAfterFailure=false
  let app=XCUIApplication(bundleIdentifier:"dev.pibot.astra-qa")
  app.launchEnvironment["PIBOT_LAYOUT_DIAGNOSTICS"]="1"
  app.terminate();XCUIDevice.shared.orientation = .portrait;app.launch()
  tap(app,"原生验收助手 · 测试")
  let pill=element(app,"打开会话详情"), baseline=pill.frame.minY
  let input=app.textViews.matching(identifier:"消息").firstMatch
  input.tap();input.typeText("Native offline multiline draft. Keep this text when cancelling connection and returning from Settings.")
  tap(app,"Done")
  tap(app,"返回会话列表");tap(app,"设置");tap(app,"工作空间")
  tap(app,"管理 合成验收空间");tap(app,"断开连接");tap(app,"关闭设置")
  tap(app,"原生验收助手 · 测试")
  XCTAssertTrue(element(app,"连接失败").exists)
  XCTAssertTrue(element(app,"连接设置").isHittable)
  XCTAssertEqual(pill.frame.minY,baseline,accuracy:1)
  XCTAssertTrue((input.value as? String)?.contains("Native offline") == true)
  XCTAssertFalse(element(app,"连接后查看会话").exists)
  XCTAssertFalse(element(app,"准备开始").exists,"Offline empty chat must not invite an unavailable send")
  shot("15-ios-inline-disconnected",app)
  for _ in 0..<2 {
   input.tap();XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout:5))
   XCTAssertEqual(pill.frame.minY,baseline,accuracy:1)
   XCTAssertLessThanOrEqual(input.frame.maxY,app.keyboards.firstMatch.frame.minY+1)
   tap(app,"Done")
  }
  tap(app,"连接设置")
  let connect=app.buttons.matching(identifier:"连接").firstMatch
  XCTAssertTrue(connect.waitForExistence(timeout:5));connect.tap()
  tap(app,"取消连接");tap(app,"关闭设置");sleep(3)
  XCTAssertTrue(element(app,"连接失败").exists,"Cancelled delayed connect must not activate")
  XCTAssertTrue((input.value as? String)?.contains("Native offline") == true)
  tap(app,"连接设置");tap(app,"添加连接")
  let address=app.textFields.matching(identifier:"服务地址").firstMatch
  XCTAssertTrue(address.waitForExistence(timeout:5));address.tap();address.typeText("https://synthetic.example.invalid")
  XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout:5))
  tap(app,"Done");tap(app,"取消并返回");tap(app,"关闭设置")
  XCTAssertEqual(pill.frame.minY,baseline,accuracy:1)
  XCTAssertTrue((input.value as? String)?.contains("Native offline") == true)
  XCUIDevice.shared.orientation = .landscapeLeft;sleep(1)
  let back=element(app,"返回会话列表"), landscapeTop=back.frame.minY
  XCTAssertTrue(element(app,"连接设置").isHittable)
  input.tap();XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout:5))
  XCTAssertEqual(back.frame.minY,landscapeTop,accuracy:1)
  XCTAssertTrue(element(app,"连接设置").isHittable)
  XCTAssertLessThanOrEqual(input.frame.maxY,app.toolbars.firstMatch.frame.minY+1)
  shot("16-ios-inline-landscape-keyboard",app)
  tap(app,"Done");tap(app,"连接设置")
  XCTAssertTrue(element(app,"关闭设置").isHittable)
  shot("17-ios-landscape-connection-settings",app)
  let close=element(app,"关闭设置")
  let closeStart=close.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.5))
  closeStart.press(forDuration:0.1,thenDragTo:closeStart.withOffset(CGVector(dx:-80,dy:20)))
  XCTAssertTrue(element(app,"关闭设置").exists,"Dragging across Close must not dismiss Settings")
  tap(app,"关闭设置");tap(app,"返回会话列表")
  XCUIDevice.shared.orientation = .portrait;sleep(1)
  XCTAssertTrue(element(app,"原生验收助手 · 测试").isHittable)
  shot("18-ios-recovery-returned-list",app)
 }
 func testInternalScrolling() {
  continueAfterFailure=false
  let app=XCUIApplication(bundleIdentifier:"dev.pibot.astra-qa")
  app.launchEnvironment["PIBOT_LAYOUT_DIAGNOSTICS"]="1"
  app.terminate();XCUIDevice.shared.orientation = .portrait;app.launch();sleep(1)
  tap(app,"原生验收助手 · 测试")
  let input=app.textViews.matching(identifier:"消息").firstMatch
  let keyboardTop=element(app,"打开会话详情").frame.minY
  for _ in 0..<3 {input.tap();tap(app,"Done");XCTAssertEqual(element(app,"打开会话详情").frame.minY,keyboardTop,accuracy:1)}
  input.tap()
  for i in 1...12 {input.tap();input.typeText("Synthetic scroll message \(i)");tap(app,"发送")}
  if app.keyboards.firstMatch.exists {tap(app,"Done")}
  let pill=element(app,"打开会话详情");let top=pill.frame.minY
  let first=app.staticTexts["Synthetic scroll message 1"]
  let last=app.staticTexts["Synthetic scroll message 12"]
  XCTAssertTrue(last.isHittable)
  let start=app.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.30))
  let end=app.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.75))
  start.press(forDuration:0.1,thenDragTo:end);start.press(forDuration:0.1,thenDragTo:end);sleep(1)
  XCTAssertTrue(first.isHittable,"Message region must scroll with native outer scrolling disabled")
  XCTAssertEqual(pill.frame.minY,top,accuracy:1)
  shot("13-native-message-scroll",app)
  tap(app,"返回会话列表")
  XCUIDevice.shared.orientation = .landscapeLeft;sleep(1)
  tap(app,"设置")
  let close=element(app,"关闭设置");let closeY=close.frame.minY
  let down=app.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.70))
  let up=app.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.36))
  down.press(forDuration:0.1,thenDragTo:up);sleep(1)
  XCTAssertTrue(element(app,"保存更改").isHittable,"Model form must scroll to its save action")
  XCTAssertEqual(close.frame.minY,closeY,accuracy:1)
  shot("14-native-form-scroll",app)
  tap(app,"关闭设置")
  XCUIDevice.shared.orientation = .portrait
 }
 func testNativeFlows() {
  continueAfterFailure=false
  let app=XCUIApplication(bundleIdentifier:"dev.pibot.astra-qa")
  XCUIDevice.shared.orientation = .portrait
  app.activate();sleep(1)
  tap(app,"原生验收助手 · 测试")
  let pill=element(app,"打开会话详情")
  let baseline=pill.frame.minY
  XCTAssertGreaterThan(baseline,40)
  shot("02-native-chat",app)
  tap(app,"打开会话详情");shot("03-native-details",app);tap(app,"关闭详情")
  XCTAssertEqual(pill.frame.minY,baseline,accuracy:1,"Pill close must not move header")
  let input=app.textViews.matching(identifier:"消息").firstMatch
  XCTAssertTrue(input.waitForExistence(timeout:5));input.tap()
  XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout:5),"Actual software keyboard must be visible")
  input.typeText("Native multiline draft. Keep the title steady while this longer message wraps across several lines. Continue the idea tomorrow.")
  Thread.sleep(forTimeInterval:0.8)
  XCTAssertEqual(pill.frame.minY,baseline,accuracy:1,"Keyboard must not shift header")
  XCTAssertLessThanOrEqual(input.frame.maxY,app.keyboards.firstMatch.frame.minY+1)
  shot("04-native-keyboard-multiline",app)
  tap(app,"打开会话详情");shot("05-native-pill-after-keyboard",app);tap(app,"关闭详情")
  XCTAssertEqual(pill.frame.minY,baseline,accuracy:1)
  tap(app,"返回会话列表")
  XCTAssertFalse(app.keyboards.firstMatch.exists,"Back dismisses keyboard")
  tap(app,"设置");shot("06-native-models",app)
  let modelPicker=app.otherElements.matching(NSPredicate(format:"label == %@ AND value CONTAINS %@", "默认模型", "Balanced")).firstMatch
  XCTAssertTrue(modelPicker.waitForExistence(timeout:5));modelPicker.tap()
  let search=app.textFields.matching(identifier:"搜索默认模型").firstMatch
  XCTAssertTrue(search.waitForExistence(timeout:5));search.tap();search.typeText("Fast")
  XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout:5))
  shot("07-native-model-search-keyboard",app)
  print("MODEL_TREE",app.debugDescription)
  tap(app,"Fast · 测试模型 演示提供商（假数据） · fast")
  tap(app,"保存更改");shot("08-native-model-saved",app)
  XCTAssertTrue(app.otherElements.matching(NSPredicate(format:"label == %@ AND value CONTAINS %@", "默认模型", "Fast")).firstMatch.exists)
  tap(app,"关闭设置")
  tap(app,"原生验收助手 · 测试")
  XCUIDevice.shared.orientation = .landscapeLeft
  sleep(1)
  XCTAssertTrue(element(app,"返回会话列表").isHittable)
  let landscapeTop=pill.frame.minY
  shot("09-native-landscape",app)
  let landscapeInput=app.textViews.matching(identifier:"消息").firstMatch
  landscapeInput.tap()
  XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout:5))
  XCTAssertEqual(pill.frame.minY,landscapeTop,accuracy:1,"Landscape keyboard must not shift header")
  let keyboardToolbar=app.toolbars.firstMatch
  XCTAssertTrue(keyboardToolbar.exists)
  XCTAssertLessThanOrEqual(landscapeInput.frame.maxY,keyboardToolbar.frame.minY+1,"Input must also clear keyboard accessory toolbar")
  shot("10-native-landscape-keyboard",app)
  XCTAssertLessThanOrEqual(landscapeInput.frame.maxY,app.keyboards.firstMatch.frame.minY+1)
  tap(app,"返回会话列表");tap(app,"设置")
  shot("11-native-landscape-models",app)
  XCTAssertTrue(element(app,"关闭设置").isHittable)
  tap(app,"关闭设置")
  XCUIDevice.shared.orientation = .portrait
  sleep(1)
  shot("12-native-returned-list",app)
 }
}
