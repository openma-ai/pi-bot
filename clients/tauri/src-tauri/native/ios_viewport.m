#import <WebKit/WebKit.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>

static char PiboPageOriginKey;
static char PiboPageOriginContext;

// scrollEnabled only prevents gestures; UIKit can still pan a focused field
// programmatically. Constrain the outer scroll view before that offset is drawn.
// DOM message/form scrollers are separate views and are not observed here.
@interface PiboPageOriginGuard : NSObject
@property(nonatomic, weak) UIScrollView *scrollView;
@end
@implementation PiboPageOriginGuard
- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
    if (context != &PiboPageOriginContext) {
        [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
        return;
    }
    UIScrollView *scrollView = self.scrollView;
    if (fabs(scrollView.zoomScale - 1) < 0.01 && !CGPointEqualToPoint(scrollView.contentOffset, CGPointZero))
        [scrollView setContentOffset:CGPointZero animated:NO];
}
- (void)dealloc {
    [self.scrollView removeObserver:self forKeyPath:@"contentOffset" context:&PiboPageOriginContext];
}
@end

void pibo_configure_ios_viewport(void *pointer) {
    WKWebView *webview = (__bridge WKWebView *)pointer;
    UIScrollView *scrollView = webview.scrollView;
    scrollView.scrollEnabled = NO;
    scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
    if (!objc_getAssociatedObject(webview, &PiboPageOriginKey)) {
        PiboPageOriginGuard *guard = [PiboPageOriginGuard new];
        guard.scrollView = scrollView;
        [scrollView addObserver:guard forKeyPath:@"contentOffset" options:0 context:&PiboPageOriginContext];
        objc_setAssociatedObject(webview, &PiboPageOriginKey, guard, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    [scrollView setContentOffset:CGPointZero animated:NO];
    if ([NSProcessInfo.processInfo.environment[@"PIBOT_LAYOUT_DIAGNOSTICS"] isEqualToString:@"1"]) {
        [webview evaluateJavaScript:@"window.__piboNativeLayout={outerScrolling:false,insets:'css',originGuard:true}" completionHandler:nil];
    }
}
