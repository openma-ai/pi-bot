#import <Foundation/Foundation.h>
#import <TargetConditionals.h>
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
