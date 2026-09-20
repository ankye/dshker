package main

// Pairing and connection commands. They are the operations a headless machine
// needs most: list what this device is paired with, mint a code another machine
// can redeem, and open the session. Every peer operation travels in the host's
// {serviceId, data} envelope, exactly as the shell sends it, so the refusal codes
// are the shell's own. The service id names the configured coordinator account;
// on a host that has never been configured these commands refuse with
// p2p.service_unconfigured rather than guessing one.
import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"time"
)

// runPair lists, shares, or redeems a pairing code.
func runPair(args []string, stdout io.Writer, stderr io.Writer) int {
	flags := flag.NewFlagSet("pair", flag.ContinueOnError)
	flags.SetOutput(stderr)
	state := flags.String("state", "", "per-user state directory")
	service := flags.String("service", "", "the configured service id")
	share := flags.String("share", "", "mint an invite code for one network id")
	invite := flags.String("invite", "", "redeem an invite code")
	network := flags.String("network", "", "the network an invite code belongs to")
	if flags.Parse(args) != nil {
		return 2
	}
	if *share != "" && *invite != "" {
		return fail(stderr, errors.New("p2p.invalid_arguments"))
	}
	directory, err := stateRoot(*state)
	if err != nil {
		return fail(stderr, err)
	}
	// The service id and the network are machine facts: configured once, reused
	// by every later pairing command. A flag still wins and is recorded.
	stored, err := LoadConfig(directory)
	if err != nil {
		return fail(stderr, err)
	}
	effectiveService, serviceChanged := resolveString(*service, stored.Service)
	effectiveNetwork, networkChanged := resolveString(*network, stored.Network)
	// The service has no default: it names the coordinator account, and guessing
	// one would sign this machine in somewhere the operator never chose.
	if err := requireValue(effectiveService); err != nil {
		return fail(stderr, err)
	}
	// Redeeming a code needs the network it belongs to, from the flag or the record.
	if *invite != "" && effectiveNetwork == "" {
		return fail(stderr, errors.New("p2p.invalid_arguments"))
	}
	if serviceChanged || networkChanged {
		stored.Service = effectiveService
		stored.Network = effectiveNetwork
		if err := SaveConfig(directory, stored); err != nil {
			return fail(stderr, err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	client, closeClient, err := clientFor(ctx, directory)
	if err != nil {
		return fail(stderr, err)
	}
	defer closeClient()
	var answer json.RawMessage
	switch {
	case *share != "":
		answer, err = client.Call(ctx, "pairs.share", scopedRequest(effectiveService, struct {
			NetworkID string `json:"networkId"`
		}{*share}))
	case *invite != "":
		answer, err = client.Call(ctx, "pairs.invite", scopedRequest(effectiveService, struct {
			Code      string `json:"code"`
			NetworkID string `json:"networkId"`
		}{*invite, effectiveNetwork}))
	default:
		answer, err = client.Call(ctx, "pairs.list", scopedRequest(effectiveService, struct{}{}))
	}
	if err != nil {
		return fail(stderr, err)
	}
	if _, err := fmt.Fprintf(stdout, "%s\n", answer); err != nil {
		return fail(stderr, err)
	}
	return 0
}

// runConnect opens or closes one paired session.
func runConnect(args []string, stdout io.Writer, stderr io.Writer) int {
	flags := flag.NewFlagSet("connect", flag.ContinueOnError)
	flags.SetOutput(stderr)
	state := flags.String("state", "", "per-user state directory")
	service := flags.String("service", "", "the configured service id")
	pair := flags.String("pair", "", "the paired device id")
	generation := flags.Uint64("generation", 1, "the attempt generation")
	disconnect := flags.Bool("disconnect", false, "close the session instead of opening it")
	if flags.Parse(args) != nil {
		return 2
	}
	directory, err := stateRoot(*state)
	if err != nil {
		return fail(stderr, err)
	}
	// Both the service and the peer are remembered, so reconnecting the same pair
	// after a restart is `dshkerd connect` with no arguments.
	stored, err := LoadConfig(directory)
	if err != nil {
		return fail(stderr, err)
	}
	effectiveService, serviceChanged := resolveString(*service, stored.Service)
	effectivePair, pairChanged := resolveString(*pair, stored.Pair)
	if err := requireValue(effectiveService); err != nil {
		return fail(stderr, err)
	}
	if err := requireValue(effectivePair); err != nil {
		return fail(stderr, err)
	}
	if serviceChanged || pairChanged {
		stored.Service = effectiveService
		stored.Pair = effectivePair
		if err := SaveConfig(directory, stored); err != nil {
			return fail(stderr, err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	client, closeClient, err := clientFor(ctx, directory)
	if err != nil {
		return fail(stderr, err)
	}
	defer closeClient()
	if *disconnect {
		answer, err := client.Call(ctx, "peer.disconnect", scopedRequest(effectiveService, struct {
			PairID string `json:"pairId"`
		}{effectivePair}))
		if err != nil {
			return fail(stderr, err)
		}
		if _, err := fmt.Fprintf(stdout, "%s\n", answer); err != nil {
			return fail(stderr, err)
		}
		return 0
	}
	answer, err := client.Call(ctx, "peer.connect", scopedRequest(effectiveService, struct {
		PairID     string `json:"pairId"`
		Generation uint64 `json:"generation"`
	}{effectivePair, *generation}))
	if err != nil {
		return fail(stderr, err)
	}
	if _, err := fmt.Fprintf(stdout, "%s\n", answer); err != nil {
		return fail(stderr, err)
	}
	return 0
}

// scopedRequest wraps one peer operation the way the host expects it.
func scopedRequest(serviceID string, data any) any {
	encoded, err := json.Marshal(data)
	if err != nil {
		return struct{}{}
	}
	return struct {
		ServiceID string          `json:"serviceId"`
		Data      json.RawMessage `json:"data"`
	}{serviceID, encoded}
}
