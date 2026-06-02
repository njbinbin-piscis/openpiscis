"""
ML14 Hybrid Causal Discovery Prototype: LLM Prior + PC Algorithm

This script demonstrates a hybrid approach to causal discovery:
1. Use an LLM (simulated here) to generate prior knowledge about variable relationships.
2. Use the PC algorithm (from causal-learn) with these priors as constraints.

Author: Piscis (The Smart Cat)
Date: 2026-05-21
"""

import numpy as np
import networkx as nx
from causallearn.search.ConstraintBased.PC import pc
from causallearn.utils.GraphUtils import GraphUtils
from causallearn.utils.cit import chisq, fisherz
import matplotlib.pyplot as plt

# --- 1. Data Loading ---
# We use the 'sachs' dataset from causal-learn as a proxy for ARC-Bench ML14.
# In a real scenario, you would load data from ARC-Bench.
from causallearn.data.DataLoader import DataLoader
data_loader = DataLoader()
data = data_loader.load_sachs()  # Returns a Data object
X = data.X  # numpy array of shape (n_samples, n_vars)
var_names = data.var_names  # List of variable names

print(f"Data loaded: {X.shape[0]} samples, {X.shape[1]} variables.")
print(f"Variables: {var_names}")

# --- 2. Simulated LLM Prior Generation ---
def simulate_llm_prior(var_names):
    """
    Simulates an LLM generating prior knowledge.
    In a real implementation, this would call an LLM API with a prompt like:
    'Given these biological variables: {var_names}, which pairs are likely to have a direct causal relationship?'
    
    Here, we randomly select some edges to simulate the LLM's "guess".
    Note: This is a *very* rough simulation. A real LLM would use domain knowledge.
    """
    print("\n--- Simulating LLM Prior Generation ---")
    n_vars = len(var_names)
    prior_edges = []
    
    # Let's assume the LLM is 70% accurate and suggests 5 edges.
    # For demonstration, we'll hardcode some edges that are actually in the Sachs ground truth.
    # Ground truth for Sachs includes edges like: ('raf', 'mek'), ('mek', 'erk'), etc.
    
    # Simulated LLM output (list of tuples)
    simulated_llm_suggestions = [
        ('raf', 'mek'),
        ('mek', 'erk'),
        ('plcg', 'pip2'),
        ('pip2', 'pip3'),
        ('pkc', 'raf')
    ]
    
    # Convert variable names to indices
    name_to_idx = {name: i for i, name in enumerate(var_names)}
    
    for u, v in simulated_llm_suggestions:
        if u in name_to_idx and v in name_to_idx:
            i, j = name_to_idx[u], name_to_idx[v]
            prior_edges.append((i, j))
            print(f"  LLM suggests: {u} -> {v}")
            
    return prior_edges

prior_edges = simulate_llm_prior(var_names)

# --- 3. PC Algorithm with Priors ---
print("\n--- Running PC Algorithm with Priors ---")

# The PC algorithm in causal-learn doesn't directly take "prior edges" as a simple argument.
# However, we can use the `knowledge` object to add required or forbidden edges.
from causallearn.graph.GeneralGraph import GeneralGraph
from causallearn.graph.GraphNode import GraphNode
from causallearn.graph.Endpoint import Endpoint
from causallearn.utils.Knowledge import Knowledge

# Create a knowledge object
nodes = [GraphNode(name) for name in var_names]
knowledge = Knowledge()

# Add the LLM-suggested edges as "required" edges.
# Note: In a real hybrid model, we might use these as "tips" rather than hard constraints.
# For this demo, we'll add them as required edges to see if the PC algorithm respects them.
for i, j in prior_edges:
    knowledge.add_required_edge(i, j)
    print(f"  Added required edge: {var_names[i]} -> {var_names[j]}")

# Run PC algorithm
# We use the Fisher's Z test for continuous data.
cg = pc(X, 0.05, knowledge=knowledge, cit=fisherz)

# Get the resulting graph
G = cg.G

# --- 4. Visualization & Output ---
print("\n--- Resulting Causal Graph ---")
print(G)

# Convert to NetworkX for easier visualization
nx_graph = nx.DiGraph()
nx_graph.add_nodes_from(var_names)

# Extract edges from the GeneralGraph object
for i in range(len(var_names)):
    for j in range(len(var_names)):
        if G.get_edge_type(i, j) == Endpoint.TAIL and G.get_edge_type(j, i) == Endpoint.ARROW:
            nx_graph.add_edge(var_names[i], var_names[j])
        elif G.get_edge_type(i, j) == Endpoint.ARROW and G.get_edge_type(j, i) == Endpoint.TAIL:
            nx_graph.add_edge(var_names[j], var_names[i])
        # Note: Undirected edges are represented differently in GeneralGraph

# Plot the graph
plt.figure(figsize=(12, 8))
pos = nx.spring_layout(nx_graph, seed=42)
nx.draw(nx_graph, pos, with_labels=True, node_color='lightblue', node_size=2000, font_size=10, font_weight='bold', arrows=True)
plt.title("Hybrid Causal Discovery: LLM Prior + PC Algorithm")
plt.savefig("/home/agent/Projects/openpiscis/koi_debate_arc/causal_graph.png")
print("\nGraph saved to /home/agent/Projects/openpiscis/koi_debate_arc/causal_graph.png")

# --- 5. Evaluation (Optional) ---
# In a real experiment, you would compare this graph to the ground truth using SHD or F1 score.
print("\n--- Prototype Complete ---")
print("This is a simplified demonstration. In a real ARC-Bench experiment:")
print("1. You would use the actual ML14 datasets.")
print("2. The LLM prior generation would be more sophisticated (e.g., using chain-of-thought).")
print("3. You would evaluate against ground truth using metrics like SHD.")
