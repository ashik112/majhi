package platform

import (
	"sync"

	"majhi/host/internal/protocol"
)

// An isolated helper (MAJHI_HOST_ISOLATED=1) runs next to a test server. It never reads or writes the
// owner's Keychain or keyring, and never loads keys into the owner's SSH agent: its keyring lives in
// memory and it has no agent.

type memoryKeyring struct {
	mu    sync.Mutex
	items map[string]string
}

func (k *memoryKeyring) Check() protocol.KeyringState {
	return protocol.KeyringState{Kind: protocol.KeyringKeychain}
}

func (k *memoryKeyring) Read(item KeyringItem) (string, bool, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	secret, ok := k.items[item.Service+"\x00"+item.Account]
	return secret, ok, nil
}

func (k *memoryKeyring) Write(item KeyringItem, secret string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.items == nil {
		k.items = map[string]string{}
	}
	k.items[item.Service+"\x00"+item.Account] = secret
	return nil
}

func (k *memoryKeyring) Remove(item KeyringItem) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	delete(k.items, item.Service+"\x00"+item.Account)
	return nil
}

type noAgent struct{ compose string }

func (noAgent) Socket() string          { return "" }
func (noAgent) Passphrases() Keeping    { return KeepNone }
func (a noAgent) ComposeSocket() string { return a.compose }
func (noAgent) Serve() func()           { return func() {} }

// Isolated is p without the owner's keyring and SSH agent.
func Isolated(p Platform) Platform {
	return isolatedPlatform{Platform: p, keyring: &memoryKeyring{}, agent: noAgent{compose: p.SSHAgent().ComposeSocket()}}
}

type isolatedPlatform struct {
	Platform
	keyring Keyring
	agent   SSHAgent
}

func (i isolatedPlatform) Keyring() Keyring   { return i.keyring }
func (i isolatedPlatform) SSHAgent() SSHAgent { return i.agent }
