#import <Foundation/Foundation.h>
#import <TargetConditionals.h>
#import <AuthenticationServices/AuthenticationServices.h>
#if TARGET_OS_IPHONE
#import <UIKit/UIKit.h>
#else
#import <AppKit/AppKit.h>
#endif
typedef void (*PiboExportDone)(int,void*);
void pibo_export_file(const char *source,const char *name,PiboExportDone done,void *context) {
 NSString *path=[NSString stringWithUTF8String:source];
 NSString *filename=[NSString stringWithUTF8String:name];
 dispatch_async(dispatch_get_main_queue(), ^{
#if TARGET_OS_IPHONE
  UIWindow *window=nil;
  for(UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
   if(scene.activationState==UISceneActivationStateForegroundActive && [scene isKindOfClass:UIWindowScene.class]) {
    for(UIWindow *candidate in ((UIWindowScene*)scene).windows) if(candidate.isKeyWindow){window=candidate;break;}
   }
  }
  UIViewController *presenter=window.rootViewController;
  while(presenter.presentedViewController)presenter=presenter.presentedViewController;
  if(!presenter){done(-1,context);return;}
  UIActivityViewController *sheet=[[UIActivityViewController alloc] initWithActivityItems:@[[NSURL fileURLWithPath:path]] applicationActivities:nil];
  sheet.completionWithItemsHandler=^(UIActivityType type,BOOL completed,NSArray *items,NSError *error){done(error?-1:completed?1:0,context);};
  sheet.popoverPresentationController.sourceView=presenter.view;
  sheet.popoverPresentationController.sourceRect=CGRectMake(CGRectGetMidX(presenter.view.bounds),CGRectGetMidY(presenter.view.bounds),1,1);
  [presenter presentViewController:sheet animated:YES completion:nil];
#else
  NSSavePanel *panel=[NSSavePanel savePanel];panel.nameFieldStringValue=filename;
  [panel beginWithCompletionHandler:^(NSModalResponse response){
   if(response!=NSModalResponseOK){done(0,context);return;}
   NSData *data=[NSData dataWithContentsOfFile:path];NSError *error=nil;
   BOOL saved=data && [data writeToURL:panel.URL options:NSDataWritingAtomic error:&error];
   done(saved?1:-1,context);
  }];
#endif
 });
}

// No custom callback is required: SDK status polling closes the sheet on Running.
@interface PiboAuthAnchor : NSObject <ASWebAuthenticationPresentationContextProviding>
@end
@implementation PiboAuthAnchor
- (ASPresentationAnchor)presentationAnchorForWebAuthenticationSession:(ASWebAuthenticationSession *)session {
#if TARGET_OS_IPHONE
 for(UIScene *scene in UIApplication.sharedApplication.connectedScenes) if([scene isKindOfClass:UIWindowScene.class] && scene.activationState==UISceneActivationStateForegroundActive) for(UIWindow *window in ((UIWindowScene*)scene).windows) if(window.isKeyWindow)return window;
 return nil;
#else
 return NSApp.keyWindow ?: NSApp.windows.firstObject;
#endif
}
@end
static ASWebAuthenticationSession *piboAuth;
static PiboAuthAnchor *piboAnchor;
void pibo_close_login(void) {dispatch_async(dispatch_get_main_queue(),^{[piboAuth cancel];piboAuth=nil;piboAnchor=nil;});}
void pibo_open_login(const char *value,PiboExportDone done,void *context) {
 NSString *string=[NSString stringWithUTF8String:value];
 dispatch_async(dispatch_get_main_queue(), ^{
  if(piboAuth){done(1,context);return;}
  NSURL *url=[NSURL URLWithString:string];if(!url){done(-1,context);return;}
  piboAnchor=[PiboAuthAnchor new];
  __block __weak ASWebAuthenticationSession *weakSession;
  piboAuth=[[ASWebAuthenticationSession alloc] initWithURL:url callbackURLScheme:@"pibo-auth" completionHandler:^(NSURL *callback,NSError *error){(void)callback;(void)error;if(piboAuth==weakSession){piboAuth=nil;piboAnchor=nil;}}];
  weakSession=piboAuth;
  piboAuth.presentationContextProvider=piboAnchor;
  // Reuse the user's browser session; credentials remain owned by the OS browser.
  BOOL started=[piboAuth start];if(!started){piboAuth=nil;piboAnchor=nil;}
  done(started?1:-1,context);
 });
}

// SDK working files are private, non-backed-up, and protected while iOS is locked.
int pibo_protect_node_directory(const char *value) {
 NSString *path=[NSString stringWithUTF8String:value];NSError *error=nil;
 NSURL *url=[NSURL fileURLWithPath:path isDirectory:YES];
 if(![url setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:&error])return -1;
#if TARGET_OS_IPHONE
 if(![NSFileManager.defaultManager setAttributes:@{NSFileProtectionKey:NSFileProtectionComplete} ofItemAtPath:path error:&error])return -1;
#endif
 return 0;
}

bool pibo_is_direct_test_bundle(void) {return [NSBundle.mainBundle.bundleIdentifier isEqualToString:@"dev.pibot.direct-simulator"];}

// Model OAuth links are already matched to a live SDK event in Rust. Use the
// system browser without sharing or cancelling the Tailscale auth session.
void pibo_open_model_login(const char *value,PiboExportDone done,void *context) {
 NSString *string=[NSString stringWithUTF8String:value];
 dispatch_async(dispatch_get_main_queue(), ^{
  NSURL *url=[NSURL URLWithString:string];
  if(!url || ![url.scheme isEqualToString:@"https"] || url.user || url.password){done(-1,context);return;}
#if TARGET_OS_IPHONE
  [UIApplication.sharedApplication openURL:url options:@{} completionHandler:^(BOOL success){done(success?1:-1,context);}];
#else
  done([NSWorkspace.sharedWorkspace openURL:url]?1:-1,context);
#endif
 });
}
