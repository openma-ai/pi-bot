//! Compile-only shared desktop/iOS SSH feasibility boundary. Not yet wired into the app.
//! No key loading, credential persistence, default trust, or host connection is performed.
use russh::{client, keys::PublicKeyOrCertificate};

pub struct PinnedHost { expected_public_key: String }
impl PinnedHost {
    pub fn new(authorized_public_key: &str) -> Result<Self, &'static str> {
        let fields=authorized_public_key.split_whitespace().take(2).collect::<Vec<_>>();
        if fields.len()!=2 || !fields[0].starts_with("ssh-") || fields[1].is_empty() {return Err("A previously verified host public key is required");}
        Ok(Self{expected_public_key:fields.join(" ")})
    }
    fn matches(&self,presented:&str)->bool {
        let canonical=presented.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
        !self.expected_public_key.is_empty() && canonical==self.expected_public_key
    }
}
impl client::Handler for PinnedHost {
    type Error=russh::Error;
    async fn check_server_key(&mut self,key:&PublicKeyOrCertificate)->Result<bool,Self::Error> {
        if key.certificate().is_some(){return Ok(false);}
        Ok(key.public_key().to_openssh().ok().is_some_and(|text|self.matches(&text)))
    }
}
// Each request/SSE stream gets an independent channel from the same authenticated session.
pub async fn runtime_channel(session:&client::Handle<PinnedHost>,port:u16)->Result<impl tokio::io::AsyncRead+tokio::io::AsyncWrite+Unpin,russh::Error> {
    Ok(session.channel_open_direct_tcpip("127.0.0.1",u32::from(port),"127.0.0.1",0).await?.into_stream())
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn unknown_and_changed_host_keys_are_rejected() {
        assert!(PinnedHost::new("").is_err());
        let pin=PinnedHost::new("ssh-ed25519 fixture-key trusted-label").unwrap();
        assert!(pin.matches("ssh-ed25519 fixture-key other-comment"));
        assert!(!pin.matches("ssh-ed25519 changed-key"));
        assert!(!pin.matches(""));
    }
}
