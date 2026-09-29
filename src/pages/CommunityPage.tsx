import toast from 'react-hot-toast';
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, Search, Grid, List, Mail, Award, Shield, GraduationCap, MessageCircle, UserPlus, MoreHorizontal, Eye, ChevronLeft, ChevronRight } from 'lucide-react';
import { usersApi } from '../lib/api/users';
import { streamsApi } from '../lib/api/streams';
import { OrbitUser } from '../types/database';
import { EmptyState } from '../components/common/EmptyState';
import { convexHttp as convex } from '../lib/convex';
import { api } from '../../convex/_generated/api';
import { authService } from '../lib/auth';
import { logError } from '../lib/monitoring';

interface Stream {
  id: string;
  name: string;
}

type ViewMode = 'grid' | 'list';
type RoleFilter = 'all' | 'admin' | 'moderator' | 'intern';

export function CommunityPage() {
  const navigate = useNavigate();
  const [members, setMembers] = useState<OrbitUser[]>([]);
  const [filteredMembers, setFilteredMembers] = useState<OrbitUser[]>([]);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [streamFilter, setStreamFilter] = useState<string>('all');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 50;

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    filterMembers();
    setCurrentPage(1);
  }, [members, searchQuery, roleFilter, streamFilter]);

  useEffect(() => {
    const handleClickOutside = (_event: MouseEvent) => {
      if (openMenuId) {
        setOpenMenuId(null);
      }
    };

    if (openMenuId) {
      document.addEventListener('click', handleClickOutside);
    }

    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [openMenuId]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [usersData, streamsData] = await Promise.all([
        usersApi.getActiveUsers(),
        streamsApi.getAllStreams(),
      ]);
      setMembers(usersData);
      setStreams(streamsData);
    } catch (error) {
      logError(error, { context: 'CommunityPage.loadData' });
    } finally {
      setLoading(false);
    }
  };

  const filterMembers = () => {
    let filtered = [...members];

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (member) =>
          (member.full_name ?? '').toLowerCase().includes(query) ||
          (member.email ?? '').toLowerCase().includes(query)
      );
    }

    if (roleFilter !== 'all') {
      filtered = filtered.filter((member) =>
        member.roles?.includes(roleFilter)
      );
    }

    if (streamFilter !== 'all') {
      filtered = filtered.filter(
        (member) => member.current_stream_id === streamFilter
      );
    }

    setFilteredMembers(filtered);
  };

  const getInitials = (name: string | null | undefined) => {
    return (name ?? 'U')
      .split(' ')
      .filter(Boolean)
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || 'U';
  };

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'admin':
        return 'bg-rose-50 text-rose-700 border-rose-200';
      case 'moderator':
        return 'bg-indigo-50 text-indigo-700 border-indigo-200';
      case 'intern':
        return 'bg-emerald-50 text-emerald-700 border-emerald-200';
      default:
        return 'bg-slate-100 text-slate-800 border-slate-200';
    }
  };

  const getRoleIcon = (role: string) => {
    switch (role) {
      case 'admin':
        return <Shield className="w-3 h-3" />;
      case 'moderator':
        return <Award className="w-3 h-3" />;
      case 'intern':
        return <GraduationCap className="w-3 h-3" />;
      default:
        return null;
    }
  };

  const getRoleLabel = (role: string) => {
    return role.charAt(0).toUpperCase() + role.slice(1);
  };

  const getStreamName = (streamId: string | null | undefined) => {
    if (!streamId) return 'No Stream';
    const stream = streams.find((s) => s.id === streamId);
    return stream?.name || 'Unknown Stream';
  };

  const handleSendMessage = (member: OrbitUser) => {
    // The "Message" button previously only logged to the console, so it
    // appeared functional but did nothing. /messages/:recipientId already
    // exists and opens the thread with that member.
    navigate(`/messages/${member.id}`);
  };

  const handleViewProfile = (member: OrbitUser) => {
    // Navigate unconditionally. This used to be gated behind an optional
    // `onNavigate` prop left over from the pre-router navigation scheme, but
    // the route renders <CommunityPage /> with no props — so the guard was
    // always false and every "View profile" click silently did nothing.
    // `navigate` comes from useNavigate() and needs no prop.
    navigate(`/users/${member.id}`);
  };

  /**
   * Sends a real connection request. It used to only `console.log` the name,
   * so the menu item looked functional and did nothing.
   *
   * Same mutation UserProfilePage already uses; the server refuses a duplicate
   * or a self-request, so the failure path is a toast rather than a guard here.
   */
  const handleConnect = async (member: OrbitUser) => {
    const token = authService.getToken();
    if (!token) return;

    try {
      const result = await convex.mutation(api.friendships.request, {
        token,
        friendId: member.id as never,
      });
      if (!result.success) throw new Error(result.error);

      toast.success(`Connection request sent to ${member.full_name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send that request');
    }
  };

  const totalPages = Math.ceil(filteredMembers.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedMembers = filteredMembers.slice(startIndex, endIndex);

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const MemberCard = ({ member }: { member: OrbitUser }) => (
    <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-4 hover:shadow-md transition-all">
      <div className="flex flex-col items-center text-center">
        <div className="w-14 h-14 bg-gradient-to-br from-iih-green to-iih-green-dark rounded-full flex items-center justify-center text-white font-bold text-base mb-3">
          {member.profile_photo_url ? (
            <img
              src={member.profile_photo_url}
              alt={member.full_name}
              className="w-14 h-14 rounded-full object-cover"
            />
          ) : (
            getInitials(member.full_name)
          )}
        </div>

        <h3 className="font-bold text-slate-800 text-base mb-1 line-clamp-1">{member.full_name}</h3>

        <div className="text-sm text-slate-600 mb-2 line-clamp-1 flex items-center justify-center gap-1">
          <Mail className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate">{member.email}</span>
        </div>

        <div className="flex flex-wrap gap-1.5 justify-center mb-2">
          {member.roles?.slice(0, 2).map((role) => (
            <span
              key={role}
              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border ${getRoleBadgeColor(
                role
              )}`}
            >
              {getRoleIcon(role)}
              <span className="hidden sm:inline">{getRoleLabel(role)}</span>
            </span>
          ))}
        </div>

        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700 mb-3">
          {getStreamName(member.current_stream_id)}
        </span>

        <div className="grid grid-cols-2 gap-3 w-full py-2 border-y border-slate-100 mb-3">
          <div className="text-center">
            <div className="font-bold text-slate-800 text-sm">{member.total_points || 0}</div>
            <div className="text-xs text-slate-500">Points</div>
          </div>
          <div className="text-center">
            <div className="font-bold text-iih-green text-sm">Level {member.current_level || 1}</div>
            <div className="text-xs text-slate-500">Current</div>
          </div>
        </div>

        <button
          onClick={() => handleViewProfile(member)}
          className="w-full px-4 py-1.5 bg-iih-green hover:bg-iih-green-dark text-white rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
        >
          <Eye className="w-4 h-4" />
          View Profile
        </button>
      </div>
    </div>
  );

  const MemberListItem = ({ member }: { member: OrbitUser }) => (
    <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-4 hover:shadow-md transition-all">
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 bg-gradient-to-br from-iih-green to-iih-green-dark rounded-full flex items-center justify-center text-white font-bold flex-shrink-0">
          {member.profile_photo_url ? (
            <img
              src={member.profile_photo_url}
              alt={member.full_name}
              className="w-14 h-14 rounded-full object-cover"
            />
          ) : (
            getInitials(member.full_name)
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-slate-800 text-lg truncate">{member.full_name}</h3>
              <div className="flex items-center gap-2 text-sm text-slate-600 mt-1">
                <Mail className="w-4 h-4 flex-shrink-0" />
                <span className="truncate">{member.email}</span>
              </div>
            </div>

            <div className="flex items-center gap-4 flex-shrink-0">
              <div className="text-center">
                <div className="font-bold text-slate-800">{member.total_points || 0}</div>
                <div className="text-xs text-slate-500">Points</div>
              </div>
              <div className="text-center">
                <div className="font-bold text-iih-green">Level {member.current_level || 1}</div>
                <div className="text-xs text-slate-500">Current</div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 mt-3">
            {member.roles?.map((role) => (
              <span
                key={role}
                className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border ${getRoleBadgeColor(
                  role
                )}`}
              >
                {getRoleIcon(role)}
                {getRoleLabel(role)}
              </span>
            ))}
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
              {getStreamName(member.current_stream_id)}
            </span>
          </div>

          {member.bio && (
            <p className="text-sm text-slate-600 mt-2 line-clamp-1">{member.bio}</p>
          )}

          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={() => handleViewProfile(member)}
              className="px-4 py-1.5 bg-iih-green hover:bg-iih-green-dark text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            >
              <Eye className="w-4 h-4" />
              View Profile
            </button>
            <button
              onClick={() => handleSendMessage(member)}
              className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            >
              <MessageCircle className="w-4 h-4" />
              Message
            </button>
            <div className="relative">
              <button
                onClick={() => setOpenMenuId(openMenuId === member.id ? null : member.id)}
                aria-label={`More actions for ${member.full_name}`}
                aria-haspopup="menu"
                aria-expanded={openMenuId === member.id}
                className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
              {openMenuId === member.id && (
                <div className="absolute left-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-slate-200 py-1 z-10">
                  <button
                    onClick={() => {
                      handleConnect(member);
                      setOpenMenuId(null);
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                  >
                    <UserPlus className="w-4 h-4" />
                    Connect
                  </button>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(member.email);
                      setOpenMenuId(null);
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                  >
                    <Mail className="w-4 h-4" />
                    Copy Email
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-orbit-canvas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-3xl font-bold text-slate-800 flex items-center gap-3">
                <Users className="w-8 h-8 text-iih-green" />
                Community
              </h1>
              <p className="text-slate-600 mt-1">
                {filteredMembers.length} of {members.length} members
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setViewMode('grid')}
                aria-label="Grid view"
                aria-pressed={viewMode === 'grid'}
                className={`p-2 rounded-lg transition-colors ${
                  viewMode === 'grid'
                    ? 'bg-iih-green text-white'
                    : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                <Grid className="w-5 h-5" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                aria-label="List view"
                aria-pressed={viewMode === 'list'}
                className={`p-2 rounded-lg transition-colors ${
                  viewMode === 'list'
                    ? 'bg-iih-green text-white'
                    : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                <List className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search members..."
                  aria-label="Search members"
                  className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
                />
              </div>

              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}
                aria-label="Filter by role"
                className="px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
              >
                <option value="all">All Roles</option>
                <option value="admin">Admin</option>
                <option value="moderator">Moderator</option>
                <option value="intern">Intern</option>
              </select>

              <select
                value={streamFilter}
                onChange={(e) => setStreamFilter(e.target.value)}
                aria-label="Filter by stream"
                className="px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-iih-green focus:border-transparent"
              >
                <option value="all">All Streams</option>
                {streams.map((stream) => (
                  <option key={stream.id} value={stream.id}>
                    {stream.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <div className="w-12 h-12 border-4 border-iih-green border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <p className="text-slate-600">Loading members...</p>
            </div>
          </div>
        ) : filteredMembers.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm">
            <EmptyState
              illustration="👥"
              title="No members found"
              description="Try adjusting your filters or search query to find community members."
            />
          </div>
        ) : (
          <>
            {viewMode === 'grid' ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-3">
                {paginatedMembers.map((member) => (
                  <MemberCard key={member.id} member={member} />
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                {paginatedMembers.map((member) => (
                  <MemberListItem key={member.id} member={member} />
                ))}
              </div>
            )}

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-8 bg-white rounded-xl shadow-sm border border-slate-200 px-6 py-4">
                <div className="text-sm text-slate-600">
                  Showing {startIndex + 1} to {Math.min(endIndex, filteredMembers.length)} of {filteredMembers.length} members
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handlePageChange(currentPage - 1)}
                    disabled={currentPage === 1}
                    aria-label="Previous page"
                    className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>

                  <div className="flex items-center gap-1">
                    {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                      let pageNum;
                      if (totalPages <= 7) {
                        pageNum = i + 1;
                      } else if (currentPage <= 4) {
                        pageNum = i + 1;
                      } else if (currentPage >= totalPages - 3) {
                        pageNum = totalPages - 6 + i;
                      } else {
                        pageNum = currentPage - 3 + i;
                      }

                      return (
                        <button
                          key={pageNum}
                          onClick={() => handlePageChange(pageNum)}
                          className={`min-w-[2.5rem] px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                            currentPage === pageNum
                              ? 'bg-iih-green text-white'
                              : 'hover:bg-slate-50 text-slate-700'
                          }`}
                        >
                          {pageNum}
                        </button>
                      );
                    })}
                  </div>

                  <button
                    onClick={() => handlePageChange(currentPage + 1)}
                    disabled={currentPage === totalPages}
                    aria-label="Next page"
                    className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
