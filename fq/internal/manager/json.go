package manager

import "encoding/json"

func marshal(v any) ([]byte, error) { return json.MarshalIndent(v, "", "  ") }
