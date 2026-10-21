// Offline ABI double. It never loads Tailscale, accesses DNS, or joins a network.
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
int pibo_tailscale_offline_marker(void) { return 7319; }
int tailscale_new(void) { return 1; }
int tailscale_set_dir(int s,const char*p) { return 0; }
int tailscale_set_hostname(int s,const char*p) { return 0; }
int tailscale_set_authkey(int s,const char*p) { return 0; }
int tailscale_set_ephemeral(int s,int v) { return v==1 ? 0 : -1; }
int tailscale_set_logfd(int s,int v) { return v==-1 ? 0 : -1; }
int tailscale_close(int s) { return 0; }
struct pair { int a,b; };
static void *copy(void *arg) {
 struct pair *p=arg; char b[8192]; ssize_t n;
 while((n=read(p->a,b,sizeof(b)))>0) { ssize_t o=0; while(o<n) { ssize_t w=write(p->b,b+o,n-o); if(w<=0) goto done; o+=w; } }
 done: shutdown(p->b,SHUT_WR); close(p->a);close(p->b);free(p);return NULL;
}
int tailscale_dial(int s,const char*net,const char*addr,int*out) {
 unsigned port; if(strcmp(net,"tcp") || sscanf(addr,"pibo-offline.invalid:%u",&port)!=1 || port>65535) return -1;
 int tcp=socket(AF_INET,SOCK_STREAM,0), fds[2];
 struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(port),.sin_addr.s_addr=htonl(INADDR_LOOPBACK)};
 if(connect(tcp,(void*)&a,sizeof(a)) || socketpair(AF_UNIX,SOCK_STREAM,0,fds)) {close(tcp);return -1;}
 struct pair *p=malloc(sizeof(*p)),*q=malloc(sizeof(*q));
 *p=(struct pair){dup(fds[1]),dup(tcp)};*q=(struct pair){tcp,fds[1]};
 pthread_t t,u;pthread_create(&t,NULL,copy,p);pthread_detach(t);pthread_create(&u,NULL,copy,q);pthread_detach(u);
 *out=fds[0];return 0;
}
