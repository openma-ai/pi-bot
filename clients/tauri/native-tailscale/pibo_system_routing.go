package main

import "C"
import (
	"tailscale.com/net/netns"
	"tailscale.com/types/logger"
)

// Pibo is a userspace application, not the system VPN. Its outer sockets must
// follow existing OS routes (including another VPN), rather than bind en0.
// This changes only libtailscale's process-local socket policy.
//
//export pibo_tailscale_use_system_routing
func pibo_tailscale_use_system_routing() {
	netns.SetDisableBindConnToInterface(logger.Discard, true)
}
